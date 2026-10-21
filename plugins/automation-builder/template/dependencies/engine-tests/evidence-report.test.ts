// The evidence-pdf report: step-log parsing, the model/HTML built from step evidence, the PDF step (with an injected
// renderer, so no browser is needed) and the reporting integration.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateConfig } from '../engine/config/schema.ts';
import type { Attempt, ExecutionResults, TestResult } from '../engine/pipeline/execution.ts';
import {
  buildEvidenceModel, buildEvidenceReport, evidenceReportDir, renderEvidenceHtml, type EvidenceInputs, type PdfRenderer,
} from '../engine/pipeline/evidence-report.ts';
import { buildSummary, computeFinalTests, countOutcomes } from '../engine/pipeline/reporting.ts';
import type { RunManifest } from '../engine/pipeline/run-manager.ts';
import { STEP_LOG_ATTACHMENT, STEP_LOG_SCHEMA_VERSION, parseStepLog, type StepEvidenceLog } from '../engine/pipeline/step-evidence.ts';
import type { TestSpec, TestSpecDocument } from '../engine/pipeline/test-spec.ts';
import { tmpRoot, validConfig, writeFile } from './helpers.ts';

const RUN_ID = '20261020-120000-abc123';
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const manifest = { runId: RUN_ID, command: 'run-tests', artifacts: {} } as unknown as RunManifest;

function spec(id: string, over: Partial<TestSpec> = {}): TestSpec {
  return {
    id, title: `Title of ${id}`, source: { path: 'input/x.md', line: 1, originalId: id, sheet: null }, suite: null, module: 'Login', moduleSlug: 'login',
    priority: 'High', tags: ['smoke'], preconditions: ['The user exists'], steps: [{ index: 1, action: 'Open the login page', expected: null }],
    expectedResults: ['The heading "Dashboard" is visible'], testData: [], ambiguities: [], status: 'ready', ...over,
  };
}

function specs(...list: TestSpec[]): TestSpecDocument {
  return { schemaVersion: 2, generatedAt: '2026-10-20T00:00:00Z', sources: [], specs: list };
}

// Writes what the fixture leaves behind for one attempt (copied attachments + the log) and returns the Attempt as the
// normalized execution results hold it.
function attempt(root: string, dir: string, o: { retry?: number; status?: string; log?: Partial<StepEvidenceLog> | null; steps?: { title: string; status?: 'passed' | 'failed'; error?: string; shot?: boolean }[] }): Attempt {
  const attachments: Attempt['attachments'] = [];
  const add = (name: string, file: string, contentType: string, body: Buffer | string) => {
    const rel = `test-results/${RUN_ID}/initial/${dir}/attachments/${file}`;
    writeFile(root, rel, body as string);
    attachments.push({ name, contentType, path: rel });
  };
  if (o.log !== null) {
    const steps = (o.steps ?? []).map((s, i) => {
      const n = `step-${String(i + 1).padStart(2, '0')}`;
      if (s.shot !== false) add(n, `${n}-0123456789abcdef.jpg`, 'image/jpeg', PNG_1PX);
      return {
        index: i + 1, depth: 0, title: s.title, status: s.status ?? 'passed', startedAt: '2026-10-20T12:00:00.000Z', durationMs: 120 + i,
        error: s.error ?? null, screenshot: s.shot === false ? null : n, screenshotNote: s.shot === false ? 'the page was already closed' : null,
      };
    });
    add('final', 'final-0123456789abcdef.jpg', 'image/jpeg', PNG_1PX);
    const log: StepEvidenceLog = { schemaVersion: STEP_LOG_SCHEMA_VERSION, testTitle: 't', steps, final: { status: o.status ?? 'passed', screenshot: 'final', screenshotNote: null }, ...o.log };
    add(STEP_LOG_ATTACHMENT, 'step-evidence-log-0123456789abcdef.json', 'application/json', JSON.stringify(log));
  }
  return { retry: o.retry ?? 0, status: o.status ?? 'passed', durationMs: 500, errors: o.status === 'failed' ? [{ message: 'expect(locator).toBeVisible() failed', stack: null, location: null }] : [], attachments };
}

function result(id: string, outcome: TestResult['outcome'], attempts: Attempt[]): TestResult {
  return { key: `${id}@chromium`, testId: id, title: `[${id}] Title of ${id}`, file: 'tests/login.spec.ts', line: 7, project: 'chromium', outcome, attempts };
}

function results(tests: TestResult[]): ExecutionResults {
  return {
    schemaVersion: 1, runId: RUN_ID, label: 'initial', executedAt: '2026-10-20T12:00:00Z', command: [], exitCode: 0, runnerError: null,
    rawReport: null, runnerLog: '', stats: { total: tests.length, passed: 0, failed: 0, flaky: 0, skipped: 0 }, tests,
  };
}

function inputs(root: string, r: ExecutionResults, doc: TestSpecDocument | null, secrets: string[] = []): EvidenceInputs {
  const tests = computeFinalTests({ results: r, analysis: null, healing: null, regression: null, specs: doc, generation: null });
  return {
    rootDir: root, manifest, config: { ...validConfig(), reporters: ['json', 'evidence-pdf'] }, tests, counts: countOutcomes(tests),
    results: r, regression: null, specs: doc, secrets, now: new Date('2026-10-20T12:30:00Z'),
  };
}

const fakePdf: PdfRenderer = (_root, _html, pdf) => { writeFileSync(pdf, '%PDF-1.7\nfake'); return { ok: true, output: '' }; };

test('"evidence-pdf" is accepted only in audit mode with step screenshots switched on', () => {
  const audit = { ...validConfig(), reporters: ['html', 'json', 'allure', 'evidence-pdf'], reporting: { mode: 'audit', stepScreenshots: true } };
  assert.equal(validateConfig(audit).ok, true);
  assert.equal(validateConfig({ ...audit, reporting: { mode: 'audit' } }).ok, false, 'step screenshots are opt-in and the PDF needs them');
  assert.equal(validateConfig({ ...audit, reporting: { mode: 'full' } }).ok, false);
  assert.equal(validateConfig({ ...validConfig(), reporters: ['html', 'json', 'evidence-pdf'] }).ok, false, 'no mode, no PDF');
});

test('parseStepLog accepts a log and rejects other shapes', () => {
  const good = { schemaVersion: 1, testTitle: 'x', final: { status: 'passed', screenshot: 'final' }, steps: [{ index: 2, title: 'b', status: 'failed' }, { index: 1, title: 'a', status: 'passed', screenshot: 'step-01' }] };
  const parsed = parseStepLog(good)!;
  assert.deepEqual(parsed.steps.map((s) => [s.index, s.status, s.screenshot]), [[1, 'passed', 'step-01'], [2, 'failed', null]], 'ordered by index, missing fields defaulted');
  assert.equal(parseStepLog({ ...good, schemaVersion: 2 }), null);
  assert.equal(parseStepLog({ ...good, steps: [{ title: 5 }] }), null);
  assert.equal(parseStepLog(null), null);
});

test('the model pairs every executed step with its screenshot, in order, and counts them', (t) => {
  const root = tmpRoot(t);
  const r = results([result('TC-1', 'passed', [attempt(root, 'tc1', { steps: [{ title: 'Open the login page' }, { title: 'Enter the credentials' }] })])]);
  const m = buildEvidenceModel(inputs(root, r, specs(spec('TC-1'))));
  const a = m.tests[0]!.attempts[0]!;
  assert.deepEqual(a.steps.map((s) => [s.index, s.title, s.status, s.image !== null]), [[1, 'Open the login page', 'passed', true], [2, 'Enter the credentials', 'passed', true]]);
  assert.ok(a.final?.image);
  assert.deepEqual(m.totals, { tests: 1, steps: 2, screenshots: 3 });
  assert.deepEqual(m.gaps, []);
  assert.equal(m.tests[0]!.module, 'Login');
  assert.deepEqual(m.tests[0]!.expectedResults, ['The heading "Dashboard" is visible']);
});

test('HTML embeds each screenshot after its step and shows expected results; text is escaped', (t) => {
  const root = tmpRoot(t);
  const r = results([result('TC-1', 'passed', [attempt(root, 'tc1', { steps: [{ title: 'Type <script>alert(1)</script> & go' }, { title: 'Second' }] })])]);
  const html = renderEvidenceHtml(buildEvidenceModel(inputs(root, r, specs(spec('TC-1')))));
  assert.ok(!html.includes('<script>alert'), 'step titles are escaped');
  assert.match(html, /Type &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; go/);
  const first = html.indexOf('Type &lt;script'), second = html.indexOf('>Second<'), shot1 = html.indexOf('data:image/jpeg;base64,');
  assert.ok(first < shot1 && shot1 < second, 'screenshot 1 sits between step 1 and step 2');
  assert.equal(html.match(/<img /g)!.length, 3, 'two steps + the final state');
  assert.match(html, /The heading &quot;Dashboard&quot; is visible/);
  assert.match(html, /Steps in the test case/);
  assert.doesNotMatch(html, /src="(?!data:)/, 'no external or file references: the HTML is self-contained');
});

test('a failed attempt shows the failing step, its error and the failure state; retries are separate attempts', (t) => {
  const root = tmpRoot(t);
  const failing = (retry: number) => attempt(root, `tc2-${retry}`, { retry, status: 'failed', steps: [{ title: 'Open' }, { title: 'Expected: heading', status: 'failed', error: 'expect(locator).toBeVisible() failed' }] });
  const r = results([result('TC-2', 'failed', [failing(0), failing(1)])]);
  const html = renderEvidenceHtml(buildEvidenceModel(inputs(root, r, specs(spec('TC-2')))));
  assert.match(html, /Initial run · attempt 1 of 2/);
  assert.match(html, /Initial run · attempt 2 of 2/);
  assert.match(html, /<span class="badge failed">FAILED<\/span>/);
  assert.match(html, /Failure state/);
  assert.equal(html.match(/<pre class="err">expect\(locator\)\.toBeVisible\(\) failed<\/pre>/g)!.length, 2, 'the step error is shown once per attempt, not repeated as the attempt error');
});

test('an attempt error that no step shows (a failure outside any step) is still shown', (t) => {
  const root = tmpRoot(t);
  const a = attempt(root, 'tc7', { status: 'failed', steps: [{ title: 'Open' }] });
  a.errors = [{ message: 'Error: locator.click: Timeout 5000ms exceeded', stack: null, location: null }];
  const html = renderEvidenceHtml(buildEvidenceModel(inputs(root, results([result('TC-7', 'failed', [a])]), specs(spec('TC-7')))));
  assert.match(html, /<pre class="err">Error: locator\.click: Timeout 5000ms exceeded<\/pre>/);
});

test('missing evidence is reported as a gap, never silently dropped', (t) => {
  const root = tmpRoot(t);
  const noLog = attempt(root, 'tc3', { log: null });
  const noShot = attempt(root, 'tc4', { steps: [{ title: 'Only step', shot: false }] });
  const r = results([result('TC-3', 'passed', [noLog]), result('TC-4', 'passed', [noShot])]);
  const doc = specs(spec('TC-3'), spec('TC-4'), spec('TC-5'));
  const m = buildEvidenceModel(inputs(root, r, doc));
  assert.equal(m.gaps.length, 2);
  assert.match(m.gaps[0]!, /TC-3 .*no step evidence was recorded/);
  assert.match(m.gaps[1]!, /TC-4 .*step 1 "Only step": no screenshot — the page was already closed/);
  const html = renderEvidenceHtml(m);
  assert.match(html, /Evidence gaps \(2\)/);
  assert.match(html, /No step evidence was recorded for this attempt/);
  assert.match(html, /No screenshot: the page was already closed/);
  const blocked = m.tests.find((x) => x.testId === 'TC-5')!;
  assert.equal(blocked.outcome, 'blocked');
  assert.match(html, /This test was not executed/);
});

test('secret values are masked in step titles, errors and attempt errors', (t) => {
  const root = tmpRoot(t);
  const a = attempt(root, 'tc6', { status: 'failed', steps: [{ title: 'Enter hunter2secret', status: 'failed', error: 'could not type hunter2secret' }] });
  a.errors = [{ message: 'password hunter2secret rejected', stack: null, location: null }];
  const r = results([result('TC-6', 'failed', [a])]);
  const html = renderEvidenceHtml(buildEvidenceModel(inputs(root, r, specs(spec('TC-6')), ['hunter2secret'])));
  assert.doesNotMatch(html, /hunter2secret/);
  assert.match(html, /Enter \*\*\*/);
});

test('the PDF step: generated, renderer failures, missing tooling and an invalid PDF are told apart', (t) => {
  const root = tmpRoot(t);
  const r = results([result('TC-1', 'passed', [attempt(root, 'tc1', { steps: [{ title: 'Open' }] })])]);
  const i = inputs(root, r, specs(spec('TC-1')));
  const dir = evidenceReportDir(root, RUN_ID);

  const ok = buildEvidenceReport(i, fakePdf);
  assert.equal(ok.status, 'generated');
  assert.equal(ok.name, 'evidence-pdf');
  assert.equal(ok.path, `reports/${RUN_ID}/evidence-report/evidence-report.pdf`);
  assert.match(ok.detail!, /1 tests, 1 steps, 2 screenshots/);
  assert.ok(existsSync(path.join(dir, 'evidence-report.html')));

  const stale = buildEvidenceReport(i, () => ({ ok: false, output: 'boom\nPage.pdf: Target closed' }));
  assert.equal(stale.status, 'failed');
  assert.match(stale.detail!, /PDF rendering failed: boom \| Page\.pdf: Target closed/);
  assert.ok(!existsSync(path.join(dir, 'evidence-report.pdf')), 'a previous PDF is removed so a failed build cannot leave a stale one');

  assert.equal(buildEvidenceReport(i, () => ({ ok: false, missing: 'browser', output: '' })).status, 'missing_dependency');
  assert.match(buildEvidenceReport(i, () => ({ ok: false, missing: 'playwright', output: '' })).detail!, /@playwright\/test is required/);

  const bad = buildEvidenceReport(i, (_r, _h, pdf) => { writeFileSync(pdf, 'not a pdf'); return { ok: true, output: '' }; });
  assert.equal(bad.status, 'failed');
  assert.match(bad.detail!, /no valid PDF/);
});

test('a report with evidence gaps is still generated, with the gap count in the detail', (t) => {
  const root = tmpRoot(t);
  const r = results([result('TC-3', 'passed', [attempt(root, 'tc3', { log: null })])]);
  const status = buildEvidenceReport(inputs(root, r, specs(spec('TC-3'))), fakePdf);
  assert.equal(status.status, 'generated');
  assert.match(status.detail!, /1 evidence gap\(s\) listed on the cover page/);
});

test('report build lists evidence-pdf next to the Playwright reporters and writes it into the summary', (t) => {
  const root = tmpRoot(t);
  const r = results([result('TC-1', 'passed', [attempt(root, 'tc1', { steps: [{ title: 'Open' }] })])]);
  writeFile(root, `reports/${RUN_ID}/initial/results.json`, '{}');
  const runDir = path.join(root, '..', 'dependencies', 'runs', RUN_ID);
  const summary = buildSummary({
    rootDir: root, runDir, manifest, config: { ...validConfig(), reporters: ['json', 'evidence-pdf'] },
    results: r, analysis: null, healing: null, regression: null, specs: specs(spec('TC-1')), generation: null, pdfRenderer: fakePdf,
  });
  assert.deepEqual(summary.reporters.map((x) => `${x.name}:${x.status}`), ['json:generated', 'evidence-pdf:generated']);
  assert.match(readFileSync(path.join(runDir, 'summary.md'), 'utf8'), /- evidence-pdf: generated — reports\/.*evidence-report\.pdf \(1 tests, 1 steps, 2 screenshots/);
});
