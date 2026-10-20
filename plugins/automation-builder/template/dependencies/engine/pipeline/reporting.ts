// report_generation: final per-test outcomes, counts, reporter verification and the run summary.
// Summary files in the run directory (dependencies/runs/<run-id>/): summary.json (machine-readable) and summary.md.
// Reporter output itself lives in automation/reports/<run-id>/<label>/.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AutomationConfig, Reporter } from '../config/schema.ts';
import { readJson, toPosixRelative, writeJsonAtomic } from '../utils/fs.ts';
import { ARTIFACTS, EVIDENCE_DIR, REPORTS_DIR, reportsDirFor } from './artifact-manager.ts';
import type { ExecutionResults, Outcome } from './execution.ts';
import type { Category, FailureAnalysis } from './failure-classifier.ts';
import type { GenerationManifest } from './generation.ts';
import type { HealingLog } from './healing.ts';
import type { RunManifest, TestCounts } from './run-manager.ts';
import type { TestSpecDocument } from './test-spec.ts';

export const SUMMARY_SCHEMA_VERSION = 1;
export type FinalOutcome = Outcome | 'healed' | 'blocked';

export interface FinalTest {
  key: string;
  testId: string;
  title: string;
  project: string;
  outcome: FinalOutcome;
  category: Category | null;
  note: string | null;
  evidence: string[];
}

export interface ReporterStatus {
  name: Reporter;
  status: 'generated' | 'failed' | 'missing_dependency';
  path: string | null; // relative to automation/
  detail: string | null;
}

export interface RunSummary {
  schemaVersion: typeof SUMMARY_SCHEMA_VERSION;
  runId: string;
  command: string;
  generatedAt: string;
  counts: TestCounts;
  categories: Partial<Record<Category, number>>;
  healing: { attempts: number; healed: number; stillFailing: number; rejectedByGuard: number };
  tests: FinalTest[];
  unresolved: { key: string; reason: string }[];
  reporters: ReporterStatus[];
  runnerError: string | null;
  paths: Record<string, string>; // relative to automation/ ("../dependencies/runs/..." for run state)
}

export interface OutcomeInputs {
  results: ExecutionResults | null;
  analysis: FailureAnalysis | null;
  healing: HealingLog | null;
  regression: ExecutionResults | null;
  specs: TestSpecDocument | null;
  generation: GenerationManifest | null;
}

export function computeFinalTests(i: OutcomeInputs): FinalTest[] {
  const healed = new Set((i.healing?.entries ?? []).filter((e) => e.outcome === 'healed').map((e) => e.testId));
  const category = new Map((i.analysis?.failures ?? []).map((f) => [f.key, f.category]));
  const regression = new Map((i.regression?.tests ?? []).map((t) => [t.key, t]));
  const out: FinalTest[] = [];
  const seenIds = new Set<string>();

  for (const t of i.results?.tests ?? []) {
    seenIds.add(t.testId);
    let outcome: FinalOutcome = t.outcome;
    let note: string | null = null;
    if (t.outcome === 'flaky') note = 'passed only after retry';
    if (t.outcome === 'failed' && healed.has(t.testId)) { outcome = 'healed'; note = 'script defect repaired; rerun passed'; }
    const reg = regression.get(t.key);
    if (reg && reg.outcome === 'failed' && outcome !== 'failed') {
      note = outcome === 'healed' ? 'failed in regression validation after healing' : 'failed in regression validation';
      outcome = 'failed';
    } else if (reg && outcome === 'healed' && reg.outcome !== 'passed') {
      note = `healed, but regression outcome was ${reg.outcome}`;
    }
    out.push({
      key: t.key, testId: t.testId, title: t.title, project: t.project, outcome,
      category: outcome === 'passed' ? null : category.get(t.key) ?? null,
      note,
      evidence: t.attempts.flatMap((a) => a.attachments.map((x) => x.path)),
    });
  }

  // Specs that never ran are blocked, with the reason — never silently dropped.
  const excluded = new Map((i.generation?.excluded ?? []).map((e) => [e.testId, e.reason]));
  for (const s of i.specs?.specs ?? []) {
    if (seenIds.has(s.id)) continue;
    const reason = s.status === 'needs_clarification'
      ? `needs clarification: ${s.ambiguities.map((a) => a.message).join('; ')}`
      : excluded.get(s.id) ?? (i.results ? 'generated test produced no result' : 'not executed');
    out.push({ key: `${s.id}@-`, testId: s.id, title: s.title, project: '-', outcome: 'blocked', category: null, note: reason, evidence: [] });
  }
  return out;
}

export function countOutcomes(tests: FinalTest[]): TestCounts {
  const c: TestCounts = { total: tests.length, passed: 0, failed: 0, flaky: 0, healed: 0, blocked: 0, skipped: 0, unresolved: 0 };
  for (const t of tests) {
    c[t.outcome]++;
    if (isUnresolved(t)) c.unresolved++;
  }
  return c;
}

// Unresolved = needs human follow-up on the automation: blocked, or failed for any reason other than
// a confirmed application defect (which is a reported product bug, not an automation problem).
function isUnresolved(t: FinalTest): boolean {
  return t.outcome === 'blocked' || (t.outcome === 'failed' && t.category !== 'application_defect');
}

// ---- reporters ----

export interface AllureRunner {
  (resultsDir: string, outDir: string, rootDir: string): { ok: boolean; output: string };
}

export const defaultAllureRunner: AllureRunner = (resultsDir, outDir, rootDir) => {
  const pkg = readJson(path.join(rootDir, 'node_modules', 'allure', 'package.json'));
  if (pkg.ok) {
    const bin = (pkg.value as { bin?: string | Record<string, string> }).bin;
    const rel = typeof bin === 'string' ? bin : bin?.allure;
    if (rel) {
      const r = spawnSync(process.execPath, [path.join(rootDir, 'node_modules', 'allure', rel), 'generate', resultsDir, '-o', outDir], { cwd: rootDir, encoding: 'utf8', windowsHide: true, timeout: 10 * 60_000 });
      return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000) };
    }
  }
  // Global CLI. Paths are generated by the pipeline (run dir), never user input.
  const r = spawnSync(`allure generate "${resultsDir}" -o "${outDir}"`, { cwd: rootDir, encoding: 'utf8', shell: true, windowsHide: true, timeout: 10 * 60_000 });
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000) };
};

function nonEmptyFile(p: string): boolean {
  return existsSync(p) && statSync(p).isFile() && statSync(p).size > 0;
}

export function verifyReporters(rootDir: string, runId: string, config: AutomationConfig, label: string, allure: AllureRunner): ReporterStatus[] {
  const dir = reportsDirFor(rootDir, runId, label);
  const rel = (p: string) => toPosixRelative(rootDir, p);
  return config.reporters.map((name): ReporterStatus => {
    if (name === 'json') {
      const p = path.join(dir, 'results.json');
      const ok = readJson(p).ok;
      return { name, status: ok ? 'generated' : 'failed', path: ok ? rel(p) : null, detail: ok ? null : 'results.json missing or invalid' };
    }
    if (name === 'html') {
      const p = path.join(dir, 'html', 'index.html');
      const ok = nonEmptyFile(p);
      return { name, status: ok ? 'generated' : 'failed', path: ok ? rel(p) : null, detail: ok ? null : 'html/index.html not found' };
    }
    if (name === 'junit') {
      const p = path.join(dir, 'junit.xml');
      const ok = nonEmptyFile(p) && /<testsuites?[\s>]/.test(readFileSync(p, 'utf8').slice(0, 2000));
      return { name, status: ok ? 'generated' : 'failed', path: ok ? rel(p) : null, detail: ok ? null : 'junit.xml missing or not JUnit XML' };
    }
    // allure
    const resultsDir = path.join(dir, 'allure-results');
    if (!existsSync(resultsDir) || readdirSync(resultsDir).length === 0) {
      return { name, status: 'missing_dependency', path: null, detail: 'no allure-results: is allure-playwright installed and approved?' };
    }
    const outDir = path.join(dir, 'allure-report');
    const r = allure(resultsDir, outDir, rootDir);
    const index = path.join(outDir, 'index.html');
    if (r.ok && nonEmptyFile(index)) return { name, status: 'generated', path: rel(index), detail: null };
    return { name, status: 'failed', path: null, detail: `allure generate failed: ${r.output.trim().split('\n').slice(-3).join(' | ') || 'no index.html produced'}` };
  });
}

// ---- summary ----

export interface BuildSummaryInput extends OutcomeInputs {
  rootDir: string;
  runDir: string; // the summary is written here
  reporterRunId?: string; // whose reporter output to verify, if another run executed the tests
  manifest: RunManifest;
  config: AutomationConfig;
  label?: string; // execution label whose reporter output is verified (default "initial")
  allure?: AllureRunner;
  now?: Date;
}

export function buildSummary(i: BuildSummaryInput): RunSummary {
  const tests = computeFinalTests(i);
  const counts = countOutcomes(tests);
  const categories: Partial<Record<Category, number>> = {};
  for (const t of tests) if (t.category) categories[t.category] = (categories[t.category] ?? 0) + 1;
  const entries = i.healing?.entries ?? [];
  const label = i.label ?? 'initial';
  const reporterRunId = i.reporterRunId ?? i.manifest.runId;
  const reporters = i.results && existsSync(reportsDirFor(i.rootDir, reporterRunId, label))
    ? verifyReporters(i.rootDir, reporterRunId, i.config, label, i.allure ?? defaultAllureRunner)
    : i.config.reporters.map((name): ReporterStatus => ({ name, status: 'failed', path: null, detail: `no execution output for label "${label}" in this run` }));
  const rel = (p: string) => toPosixRelative(i.rootDir, p);
  const summary: RunSummary = {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    runId: i.manifest.runId,
    command: i.manifest.command,
    generatedAt: (i.now ?? new Date()).toISOString(),
    counts,
    categories,
    healing: {
      attempts: entries.length,
      healed: entries.filter((e) => e.outcome === 'healed').length,
      stillFailing: entries.filter((e) => e.outcome === 'still_failing').length,
      rejectedByGuard: entries.filter((e) => e.outcome === 'rejected_by_guard').length,
    },
    tests,
    unresolved: tests.filter(isUnresolved).map((t) => ({ key: t.key, reason: t.note ?? t.category ?? 'failed' })),
    reporters,
    runnerError: i.results?.runnerError ?? null,
    paths: {
      runDir: rel(i.runDir),
      evidence: rel(path.join(i.rootDir, EVIDENCE_DIR, i.manifest.runId)),
      reports: rel(path.join(i.rootDir, REPORTS_DIR, i.manifest.runId)),
      ...Object.fromEntries(Object.entries(i.manifest.artifacts).map(([k, v]) => [k, rel(path.join(i.runDir, v))])),
    },
  };
  mkdirSync(i.runDir, { recursive: true });
  writeJsonAtomic(path.join(i.runDir, ARTIFACTS.summary), summary);
  writeFileSync(path.join(i.runDir, ARTIFACTS.summaryMarkdown), renderSummaryMarkdown(summary));
  return summary;
}

export function reportersOk(s: RunSummary): boolean {
  return s.reporters.every((r) => r.status === 'generated');
}

export function renderSummaryMarkdown(s: RunSummary): string {
  const c = s.counts;
  const lines = [
    `# Test run ${s.runId}`,
    '',
    `Command: \`/${s.command}\` · generated ${s.generatedAt}`,
    '',
    '| Total | Passed | Failed | Flaky (recovered) | Healed | Blocked | Skipped | Unresolved |',
    '|---|---|---|---|---|---|---|---|',
    `| ${c.total} | ${c.passed} | ${c.failed} | ${c.flaky} | ${c.healed} | ${c.blocked} | ${c.skipped} | ${c.unresolved} |`,
    '',
    'Flaky tests passed only after a retry and are not counted as passed.',
    '',
  ];
  if (s.runnerError) lines.push(`**Runner error:** ${s.runnerError}`, '');
  const cats = Object.entries(s.categories);
  if (cats.length) lines.push('## Failure categories', '', ...cats.map(([k, v]) => `- ${k}: ${v}`), '');
  lines.push('## Healing', '', `Attempts: ${s.healing.attempts} · healed: ${s.healing.healed} · still failing: ${s.healing.stillFailing} · rejected by guard: ${s.healing.rejectedByGuard}`, '');
  const notPassed = s.tests.filter((t) => t.outcome !== 'passed');
  if (notPassed.length) {
    lines.push('## Tests needing attention', '', '| Test | Project | Outcome | Category | Note |', '|---|---|---|---|---|');
    for (const t of notPassed) lines.push(`| ${(t.title.startsWith(`[${t.testId}]`) ? t.title : `[${t.testId}] ${t.title}`).replace(/\|/g, '\\|')} | ${t.project} | ${t.outcome} | ${t.category ?? ''} | ${(t.note ?? '').replace(/\|/g, '\\|')} |`);
    lines.push('');
  }
  if (s.unresolved.length) lines.push('## Unresolved', '', ...s.unresolved.map((u) => `- ${u.key}: ${u.reason}`), '');
  lines.push('## Reports', '', ...s.reporters.map((r) => `- ${r.name}: ${r.status}${r.path ? ` — ${r.path}` : ''}${r.detail ? ` (${r.detail})` : ''}`), '');
  lines.push('## Paths', '', ...Object.entries(s.paths).map(([k, v]) => `- ${k}: ${v}`), '');
  return lines.join('\n');
}

export function validateSummary(v: unknown): string[] {
  if (typeof v !== 'object' || v === null) return ['summary must be an object'];
  const s = v as Partial<RunSummary>;
  const issues: string[] = [];
  if (s.schemaVersion !== SUMMARY_SCHEMA_VERSION) issues.push('unsupported schemaVersion');
  if (!s.counts || !Array.isArray(s.tests)) return [...issues, 'counts and tests are required'];
  if (s.counts.total !== s.tests.length) issues.push('counts.total does not match tests');
  for (const r of s.reporters ?? []) if (r.status !== 'generated') issues.push(`reporter ${r.name} ${r.status}: ${r.detail ?? ''}`);
  return issues;
}
