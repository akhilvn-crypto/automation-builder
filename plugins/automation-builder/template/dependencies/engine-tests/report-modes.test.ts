// Priority 7: reporting proportional to the need. Modes are persisted and validated, only the selected reporters are built,
// optional software is never installed without approval, report generation failures are kept apart from test failures, and
// volume and time are measured.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { saveConfig } from '../engine/config/load-config.ts';
import { REPORT_MODES, validateConfig, type AutomationConfig } from '../engine/config/schema.ts';
import { runPreflight } from '../engine/pipeline/preflight.ts';
import { buildSummary, type AllureRunner } from '../engine/pipeline/reporting.ts';
import { MODE_PROFILES, presetFor, presetForReporters, reportPlan } from '../engine/pipeline/reporting-mode.ts';
import type { RunManifest } from '../engine/pipeline/run-manager.ts';
import type { ExecutionResults } from '../engine/pipeline/execution.ts';
import { sha256File } from '../engine/utils/fs.ts';
import { dependenciesDir } from '../engine/utils/layout.ts';
import { tmpRoot, validConfig, writeDep, writeFile } from './helpers.ts';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'cli', 'pipeline.ts');
const RUN_ID = '20261020-120000-abc123';
const manifest = { runId: RUN_ID, command: 'playwright-pipeline', artifacts: {} } as unknown as RunManifest;

const withMode = (mode: string | null, over: Partial<AutomationConfig> & Record<string, unknown> = {}): unknown => {
  const c = { ...validConfig(), ...over } as Record<string, unknown>;
  if (mode) c.reporting = { mode, ...(over.reporting as object | undefined) };
  return c;
};
const valid = (c: unknown) => validateConfig(c).ok;
const issues = (c: unknown) => { const r = validateConfig(c); return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`); };

// ---- modes ----

test('a configuration without a mode keeps working exactly as chosen', () => {
  assert.equal(valid(validConfig()), true);
  assert.equal(valid({ ...validConfig(), reporters: ['json', 'junit', 'allure'] }), true);
});

test('standard stays failure-focused: no Allure or evidence PDF, and the reports are the user\'s selection', () => {
  assert.equal(valid(withMode('standard')), true);
  assert.equal(valid(withMode('standard', { reporters: ['json', 'html', 'junit'] })), true, 'extra reporters the user chose are fine');
  assert.equal(valid(withMode('standard', { reporters: ['json', 'extent'] })), true, 'the Extent report alone, without the Playwright report');
  assert.equal(valid(withMode('standard', { reporters: ['json'] })), true, 'no human-readable report is a valid choice');
  assert.match(issues(withMode('standard', { reporters: ['json', 'html', 'allure'] })).join(), /mode "standard" is failure-focused; "allure"/);
  for (const evidence of [{ video: 'on' }, { screenshot: 'on' }, { trace: 'on' }]) {
    const c = withMode('standard', { evidence: { ...validConfig().evidence, ...evidence } as AutomationConfig['evidence'] });
    assert.match(issues(c).join(), /failure-focused/, JSON.stringify(evidence));
  }
  assert.equal(valid(withMode('standard', { evidence: { video: 'off', screenshot: 'off', trace: 'on-first-retry' } })), true);
});

test('full and audit allow Allure but do not force it; step screenshots and the PDF are opt-in even in audit', () => {
  const allure = { reporters: ['json', 'html', 'allure'] } as Partial<AutomationConfig>;
  assert.equal(valid(withMode('full')), true, 'full without Allure is just a mode with failure videos');
  assert.equal(valid(withMode('full', { reporters: ['json', 'extent'] })), true);
  assert.equal(valid(withMode('full', allure)), true);
  assert.equal(valid(withMode('full', { ...allure, evidence: { video: 'on', screenshot: 'on', trace: 'on' } })), true, 'full may record everything');
  assert.equal(valid(withMode('audit', allure)), true, 'audit without opt-ins is just a heavier full');
  assert.match(issues(withMode('full', { ...allure, reporting: { stepScreenshots: true } } as never)).join(), /step screenshots are an audit-mode option/);
  assert.equal(valid(withMode('audit', { ...allure, reporting: { stepScreenshots: true } } as never)), true);
  assert.match(issues(withMode('audit', { reporters: ['json', 'html', 'allure', 'evidence-pdf'] })).join(), /evidence-pdf reporter needs reporting.stepScreenshots true/);
  assert.match(issues(withMode('full', { reporters: ['json', 'html', 'allure', 'evidence-pdf'] })).join(), /evidence-pdf reporter needs reporting.mode "audit"/);
});

test('reporting settings are validated and unknown keys are rejected', () => {
  assert.match(issues(withMode('verbose')).join(), /reporting.mode must be one of/);
  assert.equal(valid({ ...validConfig(), reporting: { mode: 'standard', token: 'x' } }), false);
  assert.equal(valid({ ...validConfig(), reporting: {} }), false, 'a reporting block needs its mode');
  assert.equal(valid({ ...validConfig(), reporting: 'standard' }), false);
  assert.equal(valid({ ...validConfig(), reporters: ['json', 'html', 'allure'], reporting: { mode: 'audit', stepScreenshots: true, maskSelectors: ['#card-number', '.ssn'] } }), true);
  assert.equal(valid({ ...validConfig(), reporters: ['json', 'html', 'allure'], reporting: { mode: 'audit', maskSelectors: [''] } }), false);
});

test('every preset is itself a valid configuration for its mode', () => {
  for (const mode of REPORT_MODES) {
    for (const opts of [{}, { stepScreenshots: true }, { evidencePdf: true }]) {
      const p = presetFor(mode, opts);
      const c = { ...validConfig(), reporters: p.reporters, evidence: p.evidence, reporting: p.reporting };
      assert.equal(valid(c), true, `${mode} ${JSON.stringify(opts)}: ${issues(c).join()}`);
    }
  }
  assert.deepEqual(presetFor('standard').reporters, ['json', 'html']);
  assert.deepEqual(presetFor('audit').optIn, { stepScreenshots: false, evidencePdf: false });
  const pdf = presetFor('audit', { evidencePdf: true });
  assert.deepEqual([pdf.reporters.includes('evidence-pdf'), pdf.reporting.stepScreenshots], [true, true]);
  assert.equal(pdf.evidence.video, 'on', 'the PDF embeds one video per test, so every test is recorded');
  assert.equal(presetFor('audit').evidence.video, 'retain-on-failure', 'without the PDF, audit keeps failure-only video');
  assert.deepEqual(presetFor('standard', { evidencePdf: true }).optIn, { stepScreenshots: false, evidencePdf: false }, 'opt-ins exist only in audit');
  assert.ok(MODE_PROFILES.standard.needs.length === 0 && MODE_PROFILES.full.needs.length > 0);
});

const everyChoice = (): string[][] => {
  const picks = ['html', 'allure', 'extent', 'evidence-pdf'];
  return Array.from({ length: 1 << picks.length }, (_, mask) => picks.filter((_p, n) => mask & (1 << n)));
};

test('each selection of the four reports gives exactly those reports, a mode that fits them, and a valid configuration', () => {
  for (const selected of everyChoice()) {
    const p = presetForReporters(selected);
    const c = { ...validConfig(), reporters: p.reporters, evidence: p.evidence, reporting: p.reporting };
    assert.equal(valid(c), true, `${selected.join('+') || 'none'}: ${issues(c).join()}`);
    assert.deepEqual(p.reporters, ['json', ...['html', 'allure', 'extent', 'evidence-pdf'].filter((r) => selected.includes(r))], 'json is always added; nothing else is');
    assert.equal(p.mode, selected.includes('evidence-pdf') ? 'audit' : selected.includes('allure') ? 'full' : 'standard');
  }
  const pdf = presetForReporters(['extent', 'evidence-pdf']);
  assert.deepEqual([pdf.reporting.stepScreenshots, pdf.evidence.video, pdf.needs], [true, 'on', ['chromium (renders the PDF)']]);
  const html = presetForReporters(['html', 'extent']);
  assert.deepEqual([html.mode, html.needs, html.reporting.stepScreenshots, html.evidence.video], ['standard', [], undefined, 'off'], 'html + extent need no software and record nothing extra');
  assert.deepEqual(presetForReporters(['allure']).needs, ['allure-playwright', 'allure CLI']);
  assert.deepEqual(presetForReporters([]).reporters, ['json']);
  assert.throws(() => presetForReporters(['html', 'junit']), /unknown report\(s\): junit/);
});

test('the Extent report needs no software; the report plan lists only what the chosen reports need', () => {
  const plan = reportPlan({ ...validConfig(), reporters: ['json', 'extent'] } as AutomationConfig);
  assert.deepEqual(plan.requires, []);
});

test('the report plan lists the software the chosen reporters need, without installing anything', () => {
  const plain = reportPlan(validConfig() as AutomationConfig);
  assert.deepEqual([plain.mode, plain.requires.length, plain.evidencePdf], [null, 0, false]);
  const audit = reportPlan({ ...validConfig(), reporters: ['json', 'html', 'allure', 'evidence-pdf'], reporting: { mode: 'audit', stepScreenshots: true } } as AutomationConfig);
  assert.deepEqual(audit.requires.map((r) => r.id), ['allure-playwright', 'allure-cli', 'browser:chromium']);
  assert.deepEqual([audit.mode, audit.stepScreenshots, audit.evidencePdf], ['audit', true, true]);
});

test('CLI: missing reporter software is proposed, never installed; declining it keeps the dependent workflow blocked', (t) => {
  const root = tmpRoot(t);
  const cfg = withMode('full', { reporters: ['json', 'html', 'allure'] }) as AutomationConfig;
  assert.deepEqual(saveConfig(root, cfg), { ok: true });
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8' });

  const plan = run('config', 'report-plan');
  assert.equal(plan.status, 2);
  const out = JSON.parse(plan.stdout);
  assert.deepEqual(out.missing, ['allure-playwright', 'allure-cli']);
  assert.match(out.approvalNeeded, /ask the user before installing each missing item, one at a time/);
  assert.equal(out.requires[0].installCommand, 'npm install --save-dev --save-exact allure-playwright');
  assert.equal(existsSync(path.join(root, 'node_modules')), false, 'nothing was installed');
  assert.equal(existsSync(path.join(root, 'package.json')), false);

  const declined = run('deps', 'record', '--dependency', 'allure-playwright', '--action', 'declined', '--reason', 'user declined');
  assert.equal(declined.status, 0);
  assert.equal(run('config', 'report-plan').status, 2, 'a recorded decline does not make the reporter available');
  const preflight = JSON.parse(run('preflight').stdout);
  assert.equal(preflight.ready, false);
  assert.deepEqual(preflight.checks.filter((c: { required: boolean; status: string }) => c.required && c.status !== 'ok').map((c: { id: string }) => c.id).filter((id: string) => id.startsWith('allure')), ['allure-playwright', 'allure-cli']);
  assert.equal(existsSync(path.join(root, 'node_modules')), false);

  const preset = JSON.parse(run('config', 'mode-preset', 'audit', '--evidence-pdf').stdout);
  assert.deepEqual([preset.mode, preset.reporters.includes('evidence-pdf'), preset.reporting.stepScreenshots], ['audit', true, true]);
  assert.equal(run('config', 'mode-preset', 'loud').status, 1);

  const chosen = JSON.parse(run('config', 'reporter-preset', '--reporters', 'html,extent,evidence-pdf').stdout);
  assert.deepEqual([chosen.reporters, chosen.mode, chosen.reporting.stepScreenshots], [['json', 'html', 'extent', 'evidence-pdf'], 'audit', true]);
  assert.deepEqual(JSON.parse(run('config', 'reporter-preset', '--reporters', 'none').stdout).reporters, ['json']);
  assert.equal(run('config', 'reporter-preset', '--reporters', 'html,junit').status, 1, 'junit is not one of the selectable reports');
  assert.equal(run('config', 'reporter-preset').status, 1, 'the selection must be stated, never assumed');
});

test('preflight needs Chromium for the evidence PDF even when the tests run in another browser', (t) => {
  const root = tmpRoot(t);
  const cfg = {
    ...validConfig(), browsers: ['firefox'], reporters: ['json', 'html', 'allure', 'evidence-pdf'], reporting: { mode: 'audit', stepScreenshots: true },
    evidence: { video: 'on', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  };
  assert.deepEqual(saveConfig(root, cfg), { ok: true });
  const report = runPreflight(root, { run: () => ({ ok: false, stdout: '' }), env: {}, nodeVersion: '24.0.0' });
  assert.deepEqual(report.checks.filter((c) => c.id.startsWith('browser:')).map((c) => c.id).sort(), ['browser:chromium', 'browser:firefox']);
});

// ---- generation ----

function execResults(failedTests = 0): ExecutionResults {
  const mk = (id: string, outcome: 'passed' | 'failed') => ({
    key: `${id}@chromium`, testId: id, title: `[${id}] ${id}`, file: 'tests/generated/a.spec.ts', line: 1, project: 'chromium', outcome,
    attempts: [{ retry: 0, status: outcome, durationMs: 5, errors: outcome === 'failed' ? [{ message: 'expect(locator).toHaveText failed', stack: null, location: null }] : [], attachments: [] }],
  });
  const tests = [mk('TC-1', 'passed'), ...Array.from({ length: failedTests }, (_, i) => mk(`TC-${i + 2}`, 'failed'))];
  return {
    schemaVersion: 1, runId: RUN_ID, label: 'initial', executedAt: 'x', command: [], exitCode: failedTests ? 1 : 0, runnerError: null, rawReport: null, runnerLog: '',
    stats: { total: tests.length, passed: 1, failed: failedTests, flaky: 0, skipped: 0 }, tests,
  };
}

function reportsOnDisk(root: string, opts: { html?: boolean; junit?: boolean } = { html: true }) {
  const base = `reports/${RUN_ID}/initial`;
  mkdirSync(path.join(root, `reports/${RUN_ID}`), { recursive: true });
  writeFile(root, `${base}/results.json`, '{"suites":[]}');
  if (opts.html !== false) writeFile(root, `${base}/html/index.html`, '<html>report</html>');
  if (opts.junit) writeFile(root, `${base}/junit.xml`, '<testsuites></testsuites>');
  writeDep(root, `runs/${RUN_ID}/execution-results.json`, '{"stand":"in"}');
}

const summary = (root: string, config: unknown, results: ExecutionResults, allure?: AllureRunner) => buildSummary({
  rootDir: root, runDir: path.join(dependenciesDir(root), 'runs', RUN_ID), manifest, config: config as AutomationConfig, results, analysis: null, healing: null,
  regression: null, specs: null, generation: null, allure,
});

test('a broken reporter is a report-generation problem; failing tests are a test problem; neither is reported as the other', (t) => {
  const brokenAllure: AllureRunner = () => ({ ok: false, output: 'allure: command not found' });
  const config = withMode('full', { reporters: ['json', 'html', 'allure'] });

  // Healthy reports of a run with failing tests.
  const root = tmpRoot(t);
  reportsOnDisk(root);
  writeFile(root, `reports/${RUN_ID}/initial/allure-results/x-result.json`, '{}');
  const goodAllure: AllureRunner = (_r, out) => { mkdirSync(out, { recursive: true }); writeFileSync(path.join(out, 'index.html'), '<html></html>'); return { ok: true, output: '' }; };
  const failingTests = summary(root, config, execResults(2), goodAllure);
  assert.deepEqual([failingTests.counts.failed, failingTests.reportGeneration.ok, failingTests.reportGeneration.failed], [2, true, []]);

  // Broken Allure with all tests passing.
  const root2 = tmpRoot(t);
  reportsOnDisk(root2);
  writeFile(root2, `reports/${RUN_ID}/initial/allure-results/x-result.json`, '{}');
  const brokenReports = summary(root2, config, execResults(0), brokenAllure);
  assert.deepEqual([brokenReports.counts.failed, brokenReports.reportGeneration.ok], [0, false]);
  assert.deepEqual(brokenReports.reportGeneration.failed.map((f) => [f.name, f.status]), [['allure', 'failed']]);
  assert.equal(brokenReports.runnerError, null);
  const md = readFileOf(root2, 'summary.md');
  assert.match(md, /Report generation: FAILED for allure — this is not a test failure/);
  assert.match(md, /Mode: full/);
});

function readFileOf(root: string, name: string): string {
  return readFileSync(path.join(dependenciesDir(root), 'runs', RUN_ID, name), 'utf8');
}

test('only the reporters the user selected are verified, and each one is measured', (t) => {
  const root = tmpRoot(t);
  reportsOnDisk(root, { html: true, junit: true });
  writeFile(root, `reports/${RUN_ID}/initial/allure-results/x-result.json`, '{}'); // leftovers of another reporter
  const s = summary(root, withMode('standard'), execResults());
  assert.deepEqual(s.reporters.map((r) => r.name), ['html', 'json'], 'junit and allure output on disk are ignored, not claimed');
  assert.ok(s.reporters.every((r) => r.status === 'generated' && (r.bytes ?? 0) > 0 && (r.files ?? 0) > 0 && r.durationMs !== undefined));
  assert.equal(s.reportGeneration.files, s.reporters.reduce((n, r) => n + (r.files ?? 0), 0));
  assert.ok(s.reportGeneration.bytes > 0 && s.reportGeneration.durationMs >= 0);
  assert.equal(s.mode, 'standard');
});

test('a reporter that left no file is never claimed as generated', (t) => {
  const root = tmpRoot(t);
  reportsOnDisk(root, { html: false });
  const s = summary(root, withMode('standard'), execResults());
  assert.deepEqual(s.reporters.map((r) => `${r.name}:${r.status}`), ['html:failed', 'json:generated']);
  assert.equal(s.reportGeneration.ok, false);
});

test('reports are generated from the normalized results and say exactly which ones', (t) => {
  const root = tmpRoot(t);
  reportsOnDisk(root);
  const s = summary(root, withMode('standard'), execResults());
  assert.equal(s.generatedFrom.executionResultsSha256, sha256File(path.join(dependenciesDir(root), 'runs', RUN_ID, 'execution-results.json')));
  assert.equal(s.generatedFrom.regressionResultsSha256, null);
});
