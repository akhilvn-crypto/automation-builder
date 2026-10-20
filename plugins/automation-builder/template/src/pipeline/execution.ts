// Runs Playwright Test for a run and normalizes the JSON reporter output into execution results
// keyed by source test ID. The executor never edits test code.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AutomationConfig } from '../config/schema.ts';
import { readJson, toPosixRelative, writeJsonAtomic } from '../utils/fs.ts';
import { redact } from '../utils/test-data.ts';
import { ARTIFACTS, assertExecutionLabel, reportsDirFor } from './artifact-manager.ts';

export const EXECUTION_SCHEMA_VERSION = 1;
export const OUTCOMES = ['passed', 'failed', 'flaky', 'skipped'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface AttemptError {
  message: string;
  stack: string | null;
  location: { file: string; line: number } | null;
}

export interface Attempt {
  retry: number;
  status: string; // passed | failed | timedOut | interrupted | skipped
  durationMs: number;
  errors: AttemptError[];
  attachments: { name: string; contentType: string; path: string }[]; // project-relative
}

export interface TestResult {
  key: string; // `${testId}@${project}` — unique per run
  testId: string;
  title: string;
  file: string; // project-relative
  line: number;
  project: string;
  outcome: Outcome; // flaky = failed first, passed on retry; never counted as passed
  attempts: Attempt[];
}

export interface ExecutionResults {
  schemaVersion: typeof EXECUTION_SCHEMA_VERSION;
  runId: string;
  label: string;
  executedAt: string;
  command: string[];
  exitCode: number | null;
  // Set when the runner itself failed (config error, crash, no report) — distinct from test failures.
  runnerError: string | null;
  rawReport: string | null; // project-relative path of Playwright's JSON report
  runnerLog: string; // project-relative
  stats: Record<Outcome, number> & { total: number };
  tests: TestResult[];
}

// ---- running ----

export interface RunOptions {
  runId: string;
  runDir: string;
  label: string;
  files?: string[]; // project-relative test files
  testIds?: string[]; // narrows to titles starting with "[ID]"
  projects?: string[];
  retries?: number; // override, e.g. 0 for healing reruns so a retry can't mask the result
  timeoutMs?: number;
}

export interface Spawner {
  (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): { status: number | null; stdout: string; stderr: string; error?: Error };
}

const defaultSpawner: Spawner = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env, encoding: 'utf8', timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
};

export function playwrightCliPath(rootDir: string): string {
  return path.join(rootDir, 'node_modules', '@playwright', 'test', 'cli.js');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildPlaywrightArgs(o: Pick<RunOptions, 'files' | 'testIds' | 'projects' | 'retries'>): string[] {
  const args = ['test', ...(o.files ?? [])];
  if (o.testIds && o.testIds.length) args.push('--grep', o.testIds.map((id) => escapeRegex(`[${id}]`)).join('|'));
  for (const p of o.projects ?? []) args.push('--project', p);
  if (o.retries !== undefined) args.push('--retries', String(o.retries));
  return args;
}

export function runPlaywright(rootDir: string, config: AutomationConfig, o: RunOptions, spawn: Spawner = defaultSpawner, env: NodeJS.ProcessEnv = process.env, now = new Date()): ExecutionResults {
  assertExecutionLabel(o.label);
  const cli = playwrightCliPath(rootDir);
  const reportsDir = reportsDirFor(o.runDir, o.label);
  mkdirSync(reportsDir, { recursive: true });
  const runnerLogAbs = path.join(reportsDir, 'runner.log');
  const rawReportAbs = path.join(reportsDir, 'results.json');
  const args = buildPlaywrightArgs(o);
  const secrets = config.auth.credentialEnvVars.map((n) => env[n]).filter((v): v is string => !!v);

  if (!existsSync(cli)) {
    writeFileSync(runnerLogAbs, `@playwright/test is not installed (${cli} missing)\n`);
    return emptyResults(rootDir, o, args, null, '@playwright/test is not installed in the project', runnerLogAbs, now);
  }
  const r = spawn(process.execPath, [cli, ...args], {
    cwd: rootDir,
    env: { ...env, PIPELINE_RUN_DIR: o.runDir, PIPELINE_LABEL: o.label, FORCE_COLOR: '0' },
    timeoutMs: o.timeoutMs ?? 60 * 60_000,
  });
  writeFileSync(runnerLogAbs, redact(`$ playwright ${args.join(' ')}\n\n${r.stdout}\n${r.stderr}`, secrets));

  const report = readJson(rawReportAbs);
  if (!report.ok) {
    const why = r.error ? r.error.message : `exit code ${r.status}`;
    return emptyResults(rootDir, o, args, r.status, `runner produced no JSON report (${why}); see ${toPosixRelative(rootDir, runnerLogAbs)}`, runnerLogAbs, now);
  }
  const results = normalizeReport(report.value, { rootDir, runId: o.runId, label: o.label, secrets, now });
  return {
    ...results,
    command: ['playwright', ...args],
    exitCode: r.status,
    rawReport: toPosixRelative(rootDir, rawReportAbs),
    runnerLog: toPosixRelative(rootDir, runnerLogAbs),
    runnerError: results.runnerError ?? (r.status !== 0 && r.status !== 1 ? `unexpected runner exit code ${r.status}` : null),
  };
}

function emptyResults(rootDir: string, o: RunOptions, args: string[], exitCode: number | null, runnerError: string, runnerLogAbs: string, now: Date): ExecutionResults {
  return {
    schemaVersion: EXECUTION_SCHEMA_VERSION, runId: o.runId, label: o.label, executedAt: now.toISOString(),
    command: ['playwright', ...args], exitCode, runnerError, rawReport: null, runnerLog: toPosixRelative(rootDir, runnerLogAbs),
    stats: { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 }, tests: [],
  };
}

// Where normalized results for a label are stored inside the run.
export function resultsPathFor(runDirectory: string, label: string): string {
  if (label === 'initial') return path.join(runDirectory, ARTIFACTS.executionResults);
  if (label === 'regression') return path.join(runDirectory, ARTIFACTS.regressionResults);
  return path.join(runDirectory, ARTIFACTS.rerunsDir, `${label}.json`);
}

export function saveResults(runDirectory: string, results: ExecutionResults): string {
  const p = resultsPathFor(runDirectory, results.label);
  mkdirSync(path.dirname(p), { recursive: true });
  writeJsonAtomic(p, results);
  return p;
}

// ---- normalizing Playwright's JSON reporter output ----

interface PwError { message?: string; stack?: string; location?: { file: string; line: number } }
interface PwResult { retry?: number; status?: string; duration?: number; error?: PwError; errors?: PwError[]; attachments?: { name: string; contentType: string; path?: string }[] }
interface PwTest { projectName?: string; annotations?: { type: string; description?: string }[]; expectedStatus?: string; status?: string; results?: PwResult[] }
interface PwSpec { title: string; file?: string; line?: number; tests?: PwTest[] }
interface PwSuite { title?: string; file?: string; specs?: PwSpec[]; suites?: PwSuite[] }
interface PwReport { config?: { rootDir?: string }; suites?: PwSuite[]; errors?: PwError[] }

const ANSI = /\u001b\[[0-9;]*m/g;
const TITLE_ID = /^\[([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9][A-Za-z0-9_-]*)\]/;

export function testIdFor(title: string, annotations: PwTest['annotations'], file: string): string {
  const a = annotations?.find((x) => x.type === 'testId' && x.description);
  if (a) return a.description!;
  const m = TITLE_ID.exec(title);
  return m ? m[1]! : `untagged:${file}:${title}`;
}

function outcomeOf(t: PwTest): Outcome {
  if (t.status === 'flaky') return 'flaky';
  if (t.status === 'skipped') return 'skipped';
  if (t.status === 'expected') return 'passed';
  return 'failed';
}

export function normalizeReport(raw: unknown, ctx: { rootDir: string; runId: string; label: string; secrets: string[]; now: Date }): ExecutionResults {
  const report = raw as PwReport;
  const testRoot = report.config?.rootDir ?? path.join(ctx.rootDir, 'tests');
  const clean = (s: string | undefined) => redact((s ?? '').replace(ANSI, ''), ctx.secrets);
  const rel = (p: string) => toPosixRelative(ctx.rootDir, path.isAbsolute(p) ? p : path.join(testRoot, p));
  const tests: TestResult[] = [];

  const walk = (suite: PwSuite, inheritedFile: string | undefined) => {
    const file = suite.file ?? inheritedFile;
    for (const spec of suite.specs ?? []) {
      const specFile = rel(spec.file ?? file ?? 'unknown');
      for (const t of spec.tests ?? []) {
        const project = t.projectName || 'default';
        const testId = testIdFor(spec.title, t.annotations, specFile);
        tests.push({
          key: `${testId}@${project}`,
          testId,
          title: spec.title,
          file: specFile,
          line: spec.line ?? 0,
          project,
          outcome: outcomeOf(t),
          attempts: (t.results ?? []).map((r) => ({
            retry: r.retry ?? 0,
            status: r.status ?? 'unknown',
            durationMs: r.duration ?? 0,
            errors: (r.errors?.length ? r.errors : r.error ? [r.error] : []).map((e) => ({
              message: clean(e.message).slice(0, 4000),
              stack: e.stack ? clean(e.stack).slice(0, 4000) : null,
              location: e.location ? { file: rel(e.location.file), line: e.location.line } : null,
            })),
            attachments: (r.attachments ?? []).filter((a) => a.path).map((a) => ({ name: a.name, contentType: a.contentType, path: rel(a.path!) })),
          })),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, file);
  };
  for (const s of report.suites ?? []) walk(s, undefined);

  const stats = { total: tests.length, passed: 0, failed: 0, flaky: 0, skipped: 0 };
  for (const t of tests) stats[t.outcome]++;
  const topErrors = (report.errors ?? []).map((e) => clean(e.message)).filter(Boolean);
  return {
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    runId: ctx.runId,
    label: ctx.label,
    executedAt: ctx.now.toISOString(),
    command: [],
    exitCode: null,
    runnerError: topErrors.length ? `runner errors: ${topErrors.join(' | ').slice(0, 4000)}` : tests.length === 0 ? 'no tests were found or run' : null,
    rawReport: null,
    runnerLog: '',
    stats,
    tests,
  };
}

export function validateExecutionResults(v: unknown): string[] {
  if (typeof v !== 'object' || v === null) return ['execution results must be an object'];
  const r = v as Partial<ExecutionResults>;
  const issues: string[] = [];
  if (r.schemaVersion !== EXECUTION_SCHEMA_VERSION) issues.push('unsupported schemaVersion');
  if (!Array.isArray(r.tests)) return [...issues, 'tests must be an array'];
  if (r.runnerError) issues.push(`runner error: ${r.runnerError}`);
  const keys = new Set<string>();
  for (const t of r.tests) {
    if (keys.has(t.key)) issues.push(`duplicate result key ${t.key} (two tests share a test ID in the same project)`);
    keys.add(t.key);
    if (!(OUTCOMES as readonly unknown[]).includes(t.outcome)) issues.push(`${t.key}: invalid outcome`);
  }
  return issues;
}
