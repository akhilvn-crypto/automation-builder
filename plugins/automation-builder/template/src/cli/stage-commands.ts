// CLI handlers for stage work: deterministic steps the orchestrator and stage agents call.
// Each handler writes its artifact inside the run dir and returns the relative path to register
// with `run stage <runId> <stage> completed --artifact <name>=<path>`.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AutomationConfig } from '../config/schema.ts';
import { readJson, toPosixRelative, writeJsonAtomic } from '../utils/fs.ts';
import { ARTIFACTS, runDir } from '../pipeline/artifact-manager.ts';
import { resultsPathFor, runPlaywright, saveResults, type ExecutionResults } from '../pipeline/execution.ts';
import { validateExplorationRecord } from '../pipeline/exploration.ts';
import {
  CATEGORIES, CONFIDENCES, buildFailureAnalysis, reclassify, saveFailureAnalysis, validateFailureAnalysis,
  type Category, type Confidence, type FailureAnalysis,
} from '../pipeline/failure-classifier.ts';
import { validateGenerationManifest, type GenerationManifest } from '../pipeline/generation.ts';
import {
  checkAttempt, eligibleFailure, ensureHealingLog, healLabel, readHealingLog, recordAttempt, revertAttempt, snapshotForAttempt,
} from '../pipeline/healing.ts';
import { validateInput } from '../pipeline/input-validation.ts';
import { buildSummary, reportersOk } from '../pipeline/reporting.ts';
import {
  HealingLimitError, loadManifest, pruneRuns, recordHealingAttempt, saveManifest, setTestCounts, type RunManifest,
} from '../pipeline/run-manager.ts';
import {
  REVIEW_SCHEMA_VERSION, SEVERITIES, reviewFiles, type ReviewFinding, type ReviewReport, type Severity,
} from '../pipeline/static-review.ts';
import { listInputFiles, parseInputs } from '../pipeline/test-case-parser.ts';
import { validateTestSpecDocument, type TestSpecDocument } from '../pipeline/test-spec.ts';

export class UsageError extends Error {}

export interface Values {
  path?: string;
  file?: string;
  label?: string;
  'test-id'?: string[];
  'test-file'?: string[];
  project?: string[];
  retries?: string;
  category?: string;
  confidence?: string;
  rationale?: string;
  evidence?: string[];
  attempt?: string;
  status?: string;
  note?: string;
}

export interface Result {
  value: unknown;
  code: number;
}

const ok = (value: unknown): Result => ({ value, code: 0 });
const notReady = (value: unknown): Result => ({ value, code: 2 });

function need(v: string | undefined, name: string): string {
  if (!v) throw new UsageError(`missing argument: ${name}`);
  return v;
}

interface RunCtx {
  root: string;
  runId: string;
  dir: string;
  manifest: RunManifest;
}

function run(root: string, runId: string | undefined): RunCtx {
  const id = need(runId, 'runId');
  const loaded = loadManifest(root, id);
  if (!loaded.ok) throw new Error(`manifest for ${id} is invalid: ${loaded.issues.join('; ')}`);
  return { root, runId: id, dir: runDir(root, id), manifest: loaded.manifest };
}

function configOf(r: RunCtx): AutomationConfig {
  if (!r.manifest.config) throw new Error(`run ${r.runId} has no configuration yet (configuration stage not done)`);
  return r.manifest.config;
}

function readArtifact<T>(dir: string, rel: string): T | null {
  const j = readJson(path.join(dir, rel));
  return j.ok ? (j.value as T) : null;
}

// This run's artifact, else the source run's (for /heal-tests and /run-tests working from an earlier run).
function artifactWithSource<T>(r: RunCtx, rel: string): { value: T | null; from: string | null } {
  const own = readArtifact<T>(r.dir, rel);
  if (own) return { value: own, from: r.runId };
  if (r.manifest.sourceRunId) {
    const src = readArtifact<T>(runDir(r.root, r.manifest.sourceRunId), rel);
    if (src) return { value: src, from: r.manifest.sourceRunId };
  }
  return { value: null, from: null };
}

function inputPathOf(r: RunCtx, v: Values): string {
  return v.path ?? configOf(r).input.testCasesPath;
}

export function stageCommand(root: string, group: string, action: string | undefined, rest: string[], v: Values): Result {
  switch (`${group} ${action}`) {
    case 'input validate': {
      const r = run(root, rest[0]);
      const inputPath = inputPathOf(r, v);
      const report = validateInput(root, r.dir, inputPath);
      // Record input files and hashes on the manifest for traceability.
      saveManifest(root, { ...r.manifest, inputs: report.files.map((f) => ({ path: f.path, sha256: f.sha256 })) });
      return { value: { ok: report.ok, artifact: ARTIFACTS.inputValidation, report }, code: report.ok ? 0 : 2 };
    }

    case 'specs parse': {
      const r = run(root, rest[0]);
      const inputPath = inputPathOf(r, v);
      const { document, errors, unsupported } = parseInputs(root, listInputFiles(root, inputPath));
      writeJsonAtomic(path.join(r.dir, ARTIFACTS.testSpecs), document);
      const issues = validateTestSpecDocument(document);
      const ready = document.specs.filter((s) => s.status === 'ready');
      const blocked = document.specs.filter((s) => s.status === 'needs_clarification');
      const value = {
        ok: issues.length === 0 && errors.length === 0 && ready.length > 0,
        artifact: ARTIFACTS.testSpecs,
        counts: { total: document.specs.length, ready: ready.length, needsClarification: blocked.length },
        needsClarification: blocked.map((s) => ({ id: s.id, title: s.title, source: s.source, ambiguities: s.ambiguities })),
        warnings: document.specs.flatMap((s) => s.ambiguities.filter((a) => a.kind === 'vague_expected_result').map((a) => ({ id: s.id, ...a }))),
        errors, unsupported, issues,
      };
      return { value, code: value.ok ? 0 : 2 };
    }

    case 'explore validate': {
      const r = run(root, rest[0]);
      const record = readArtifact(r.dir, ARTIFACTS.exploration);
      if (!record) return notReady({ ok: false, issues: [`${ARTIFACTS.exploration} is missing or not valid JSON`] });
      const issues = validateExplorationRecord(record, { runDir: r.dir, specs: readArtifact<TestSpecDocument>(r.dir, ARTIFACTS.testSpecs) });
      return { value: { ok: issues.length === 0, artifact: ARTIFACTS.exploration, issues }, code: issues.length ? 2 : 0 };
    }

    case 'generate validate': {
      const r = run(root, rest[0]);
      const g = readArtifact(r.dir, ARTIFACTS.generationManifest);
      if (!g) return notReady({ ok: false, issues: [`${ARTIFACTS.generationManifest} is missing or not valid JSON`] });
      const issues = validateGenerationManifest(g, { rootDir: root, specs: readArtifact<TestSpecDocument>(r.dir, ARTIFACTS.testSpecs) });
      if (!existsSync(path.join(r.dir, ARTIFACTS.generationReport))) issues.push(`${ARTIFACTS.generationReport} is missing`);
      return { value: { ok: issues.length === 0, artifacts: [ARTIFACTS.generationManifest, ARTIFACTS.generationReport], issues }, code: issues.length ? 2 : 0 };
    }

    case 'review static':
      return reviewStatic(run(root, rest[0]));

    case 'review add': {
      const r = run(root, rest[0]);
      const report = loadReview(r);
      const raw = JSON.parse(readFileSync(need(v.file, '--file'), 'utf8')) as Partial<ReviewFinding>[];
      if (!Array.isArray(raw)) throw new UsageError('--file must contain a JSON array of findings');
      const added = raw.map((f, i): ReviewFinding => {
        if (!(SEVERITIES as readonly unknown[]).includes(f.severity)) throw new UsageError(`finding ${i}: severity must be one of ${SEVERITIES.join(', ')}`);
        if (!f.file || !f.rule || !f.message) throw new UsageError(`finding ${i}: file, rule and message are required`);
        return { id: `R${String(report.findings.filter((x) => x.source === 'reviewer').length + i + 1).padStart(3, '0')}`, severity: f.severity as Severity, file: f.file, line: f.line ?? null, rule: f.rule, message: f.message, status: 'open', source: 'reviewer' };
      });
      return saveReview(r, { ...report, findings: [...report.findings, ...added] });
    }

    case 'review resolve': {
      const r = run(root, rest[0]);
      const id = need(rest[1], 'findingId');
      const status = need(v.status, '--status');
      if (status !== 'fixed' && status !== 'accepted') throw new UsageError('--status must be fixed or accepted');
      const report = loadReview(r);
      const f = report.findings.find((x) => x.id === id);
      if (!f) throw new UsageError(`no finding ${id}`);
      if (f.source === 'static') throw new UsageError('static findings resolve by fixing the code and re-running "review static"');
      if (status === 'accepted' && f.severity === 'critical') throw new UsageError('critical findings must be fixed, not accepted');
      return saveReview(r, { ...report, findings: report.findings.map((x) => (x.id === id ? { ...x, status, message: v.note ? `${x.message} — ${v.note}` : x.message } : x)) });
    }

    case 'exec run': {
      const r = run(root, rest[0]);
      const label = v.label ?? 'initial';
      const results = runPlaywright(root, configOf(r), {
        runId: r.runId, runDir: r.dir, label,
        files: v['test-file'], testIds: v['test-id'], projects: v.project,
        retries: v.retries === undefined ? undefined : Number(v.retries),
      });
      const file = saveResults(r.dir, results);
      const value = {
        ok: results.runnerError === null,
        artifact: toPosixRelative(r.dir, file),
        label, exitCode: results.exitCode, runnerError: results.runnerError, stats: results.stats,
        notPassed: results.tests.filter((t) => t.outcome !== 'passed').map((t) => ({ key: t.key, outcome: t.outcome, file: t.file, line: t.line })),
        runnerLog: results.runnerLog,
      };
      return { value, code: value.ok ? 0 : 2 };
    }

    case 'triage run': {
      const r = run(root, rest[0]);
      const src = artifactWithSource<ExecutionResults>(r, ARTIFACTS.executionResults);
      if (!src.value) return notReady({ ok: false, issues: ['no execution results in this run or its source run'] });
      if (src.value.runnerError) return notReady({ ok: false, issues: [`source execution had a runner error: ${src.value.runnerError}`] });
      const analysis = buildFailureAnalysis(src.value);
      saveFailureAnalysis(path.join(r.dir, ARTIFACTS.failureAnalysis), analysis);
      return ok({ ok: true, artifact: ARTIFACTS.failureAnalysis, resultsFrom: src.from, failures: analysis.failures.map(brief), eligibleForHealing: analysis.failures.filter((f) => f.healingEligible).map((f) => f.key) });
    }

    case 'triage classify': {
      const r = run(root, rest[0]);
      const key = need(rest[1], 'key');
      const category = need(v.category, '--category') as Category;
      const confidence = need(v.confidence, '--confidence') as Confidence;
      if (!CATEGORIES.includes(category)) throw new UsageError(`--category must be one of ${CATEGORIES.join(', ')}`);
      if (!CONFIDENCES.includes(confidence)) throw new UsageError(`--confidence must be one of ${CONFIDENCES.join(', ')}`);
      const analysis = loadAnalysis(r);
      const updated = reclassify(analysis, key, category, confidence, need(v.rationale, '--rationale'));
      saveFailureAnalysis(path.join(r.dir, ARTIFACTS.failureAnalysis), updated);
      return ok({ ok: true, failure: brief(updated.failures.find((f) => f.key === key || f.testId === key)!) });
    }

    case 'heal begin': {
      const r = run(root, rest[0]);
      const testId = need(rest[1], 'testId');
      const file = need(v['test-file']?.[0], '--test-file');
      const failure = eligibleFailure(loadAnalysis(r), testId);
      let reserved: { attempt: number; remaining: number };
      try {
        reserved = recordHealingAttempt(root, r.runId, testId);
      } catch (err) {
        if (err instanceof HealingLimitError) return notReady({ ok: false, limitReached: true, message: err.message });
        throw err;
      }
      const snap = snapshotForAttempt(root, r.dir, testId, reserved.attempt, file);
      return ok({ ok: true, ...reserved, snapshot: toPosixRelative(r.dir, snap), rerunLabel: healLabel(testId, reserved.attempt), failure: brief(failure) });
    }

    case 'heal check': {
      const r = run(root, rest[0]);
      const testId = need(rest[1], 'testId');
      const guard = checkAttempt(root, r.dir, testId, Number(need(v.attempt, '--attempt')), need(v['test-file']?.[0], '--test-file'));
      return { value: guard, code: guard.ok ? 0 : 2 };
    }

    case 'heal revert': {
      const r = run(root, rest[0]);
      const testId = need(rest[1], 'testId');
      revertAttempt(root, r.dir, testId, Number(need(v.attempt, '--attempt')), need(v['test-file']?.[0], '--test-file'));
      return ok({ ok: true, reverted: true });
    }

    case 'heal record': {
      const r = run(root, rest[0]);
      const testId = need(rest[1], 'testId');
      const attempt = Number(need(v.attempt, '--attempt'));
      const rerunFile = resultsPathFor(r.dir, healLabel(testId, attempt));
      const rerun = readArtifact<ExecutionResults>(r.dir, toPosixRelative(r.dir, rerunFile));
      const entry = recordAttempt(root, r.dir, {
        testId, attempt, file: need(v['test-file']?.[0], '--test-file'),
        rationale: need(v.rationale, '--rationale'), evidence: v.evidence ?? [],
        failure: eligibleFailure(loadAnalysis(r), testId),
        rerun, rerunFile: rerun ? toPosixRelative(r.dir, rerunFile) : null,
      });
      const remaining = (r.manifest.healing.maxAttemptsPerTest ?? 0) - attempt;
      return ok({ ok: true, artifact: ARTIFACTS.healingLog, outcome: entry.outcome, reverted: entry.reverted, guard: entry.guard, attemptsRemaining: Math.max(0, remaining) });
    }

    case 'heal finish': {
      const r = run(root, rest[0]);
      ensureHealingLog(r.dir);
      const log = readHealingLog(r.dir);
      return ok({ ok: true, artifact: ARTIFACTS.healingLog, healedTests: [...new Set(log.entries.filter((e) => e.outcome === 'healed').map((e) => e.testId))], healedFiles: [...new Set(log.entries.filter((e) => e.outcome === 'healed').map((e) => e.file))] });
    }

    case 'report build': {
      const r = run(root, rest[0]);
      const config = configOf(r);
      const results = artifactWithSource<ExecutionResults>(r, ARTIFACTS.executionResults);
      const summary = buildSummary({
        rootDir: root, runDir: r.dir,
        reporterRunDir: results.from ? runDir(root, results.from) : r.dir,
        manifest: r.manifest, config,
        results: results.value,
        analysis: readArtifact<FailureAnalysis>(r.dir, ARTIFACTS.failureAnalysis),
        healing: readArtifact(r.dir, ARTIFACTS.healingLog),
        regression: readArtifact<ExecutionResults>(r.dir, ARTIFACTS.regressionResults),
        specs: artifactWithSource<TestSpecDocument>(r, ARTIFACTS.testSpecs).value,
        generation: artifactWithSource<GenerationManifest>(r, ARTIFACTS.generationManifest).value,
      });
      const good = reportersOk(summary) && !summary.runnerError;
      return { value: { ok: good, artifacts: [ARTIFACTS.summary, ARTIFACTS.summaryMarkdown], counts: summary.counts, reporters: summary.reporters, unresolved: summary.unresolved, runnerError: summary.runnerError }, code: good ? 0 : 2 };
    }

    case 'run finalize': {
      const r = run(root, rest[0]);
      const summary = readArtifact<{ counts: Parameters<typeof setTestCounts>[2] }>(r.dir, ARTIFACTS.summary);
      if (summary) setTestCounts(root, r.runId, summary.counts);
      const pruned = pruneRuns(root, r.manifest.config?.retention.keepRuns ?? null, r.runId);
      return ok({ ok: true, counts: summary?.counts ?? null, pruned, summary: summary ? `output/runs/${r.runId}/${ARTIFACTS.summaryMarkdown}` : null });
    }

    default:
      throw new UsageError(`unknown command: ${group} ${action ?? ''}`.trim());
  }
}

function brief(f: FailureAnalysis['failures'][number]) {
  return { key: f.key, testId: f.testId, file: f.file, line: f.line, category: f.category, confidence: f.confidence, signals: f.signals, healingEligible: f.healingEligible, classifiedBy: f.classifiedBy, errorExcerpt: f.errorExcerpt.split('\n').slice(0, 6).join('\n'), evidence: f.evidence };
}

function loadAnalysis(r: RunCtx): FailureAnalysis {
  const a = readArtifact<FailureAnalysis>(r.dir, ARTIFACTS.failureAnalysis);
  if (!a) throw new Error(`no ${ARTIFACTS.failureAnalysis} in run ${r.runId}; run "triage run" first`);
  const issues = validateFailureAnalysis(a);
  if (issues.length) throw new Error(`${ARTIFACTS.failureAnalysis} is invalid: ${issues.join('; ')}`);
  return a;
}

// ---- review ----

function loadReview(r: RunCtx): ReviewReport {
  const existing = readArtifact<ReviewReport>(r.dir, ARTIFACTS.reviewReport);
  if (!existing) throw new Error(`no ${ARTIFACTS.reviewReport}; run "review static" first`);
  return existing;
}

function generatedFiles(r: RunCtx): string[] {
  const g = readArtifact<GenerationManifest>(r.dir, ARTIFACTS.generationManifest);
  if (!g) throw new Error(`no ${ARTIFACTS.generationManifest}; generation has not produced a manifest`);
  return [...new Set(g.tests.map((t) => t.file))].sort();
}

export function typecheckGenerated(root: string, language: AutomationConfig['language'], files: string[]): ReviewReport['typecheck'] {
  if (language === 'javascript') {
    const failures = files
      .map((f) => ({ f, r: spawnSync(process.execPath, ['--check', path.join(root, f)], { encoding: 'utf8' }) }))
      .filter(({ r }) => r.status !== 0);
    return { ran: true, ok: failures.length === 0, output: failures.map(({ f, r }) => `${f}: ${r.stderr}`).join('\n') || null };
  }
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) return { ran: false, ok: null, output: 'typescript is not installed' };
  const r = spawnSync(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.framework.json'], { cwd: root, encoding: 'utf8', windowsHide: true });
  return { ran: true, ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(0, 8000) || null };
}

function reviewStatic(r: RunCtx): Result {
  const files = generatedFiles(r);
  const fresh = reviewFiles(r.root, files);
  const prev = readArtifact<ReviewReport>(r.dir, ARTIFACTS.reviewReport);
  const freshKeys = new Set(fresh.map(findingKey));
  // Static findings from an earlier pass that no longer reproduce are marked fixed (kept for the audit trail).
  const carried = (prev?.findings ?? []).flatMap((f): ReviewFinding[] => {
    if (f.source === 'reviewer') return [f];
    return freshKeys.has(findingKey(f)) || f.status === 'fixed' ? [] : [{ ...f, status: 'fixed' }];
  });
  const prevFixed = (prev?.findings ?? []).filter((f) => f.source === 'static' && f.status === 'fixed');
  const report: ReviewReport = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    reviewedAt: new Date().toISOString(),
    files,
    typecheck: typecheckGenerated(r.root, configOf(r).language, files),
    findings: [...fresh, ...carried, ...prevFixed],
  };
  return saveReview(r, report);
}

function findingKey(f: ReviewFinding): string {
  return `${f.file}:${f.line}:${f.rule}`;
}

function saveReview(r: RunCtx, report: ReviewReport): Result {
  writeJsonAtomic(path.join(r.dir, ARTIFACTS.reviewReport), report);
  writeFileSync(path.join(r.dir, ARTIFACTS.reviewSummary), renderReview(report));
  const blocking = report.findings.filter((f) => f.severity === 'critical' && f.status !== 'fixed');
  const typecheckOk = report.typecheck.ran && report.typecheck.ok === true;
  const value = {
    ok: blocking.length === 0 && typecheckOk,
    artifacts: [ARTIFACTS.reviewReport, ARTIFACTS.reviewSummary],
    typecheck: report.typecheck,
    open: report.findings.filter((f) => f.status === 'open').map((f) => ({ id: f.id, severity: f.severity, file: f.file, line: f.line, rule: f.rule, message: f.message })),
  };
  return { value, code: value.ok ? 0 : 2 };
}

function renderReview(r: ReviewReport): string {
  const lines = [`# Script review`, '', `Reviewed ${r.reviewedAt}: ${r.files.join(', ')}`, '', `Typecheck: ${r.typecheck.ran ? (r.typecheck.ok ? 'passed' : 'FAILED') : 'not run'}`, ''];
  if (r.typecheck.ok === false && r.typecheck.output) lines.push('```', r.typecheck.output, '```', '');
  lines.push('| ID | Severity | Status | Location | Rule | Message |', '|---|---|---|---|---|---|');
  for (const f of r.findings) lines.push(`| ${f.id} | ${f.severity} | ${f.status} | ${f.file}:${f.line ?? '-'} | ${f.rule} | ${f.message.replace(/\|/g, '\\|')} |`);
  return lines.join('\n') + '\n';
}
