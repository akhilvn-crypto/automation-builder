// The "evidence-pdf" report: one PDF that shows, for every test, each step that was executed next to the screenshot taken
// when that step ended, plus the test case's expected results and the final state of the page.
//
//   reports/<run-id>/evidence-report/evidence-report.html   the printable page (images referenced, not embedded)
//   reports/<run-id>/evidence-report/evidence-report.pdf    the deliverable
//
// The step data comes from the step log the shared fixture writes while the tests run (step-evidence.ts). Building the
// model and the HTML is pure Node; only the final HTML -> PDF step needs a browser, and goes through an injectable
// PdfRenderer (default: tools/render-pdf.ts, which uses the project's already-installed @playwright/test + Chromium).

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { AutomationConfig } from '../config/schema.ts';
import { toPosixRelative } from '../utils/fs.ts';
import { redact } from '../utils/redact.ts';
import { REPORTS_DIR, assertRunId } from './artifact-manager.ts';
import type { Attempt, ExecutionResults, TestResult } from './execution.ts';
import type { FinalTest, ReporterStatus } from './reporting.ts';
import type { RunManifest, TestCounts } from './run-manager.ts';
import { STEP_LOG_ATTACHMENT, parseStepLog } from './step-evidence.ts';
import type { TestSpec, TestSpecDocument } from './test-spec.ts';

export const EVIDENCE_REPORT_DIR = 'evidence-report';
export const EVIDENCE_HTML = 'evidence-report.html';
export const EVIDENCE_PDF = 'evidence-report.pdf';

// ---- model ----

export interface StepView {
  index: number;
  depth: number;
  title: string;
  status: 'passed' | 'failed';
  startedAt: string;
  durationMs: number;
  error: string | null;
  image: string | null; // absolute path of the screenshot file
  note: string | null; // why there is no image
}

export interface AttemptView {
  label: string; // "Initial run · attempt 1"
  status: string; // Playwright's status for the attempt
  durationMs: number;
  errors: string[];
  hasStepLog: boolean;
  steps: StepView[];
  final: { status: string; image: string | null; note: string | null } | null;
  otherImages: { name: string; image: string }[]; // screenshots Playwright itself attached (e.g. on failure)
}

export interface TestView {
  anchor: string;
  testId: string;
  title: string;
  module: string | null;
  project: string;
  outcome: FinalTest['outcome'];
  category: string | null;
  note: string | null;
  file: string | null;
  priority: string | null;
  tags: string[];
  preconditions: string[];
  plannedSteps: { index: number; action: string; expected: string | null }[];
  expectedResults: string[];
  attempts: AttemptView[];
}

export interface EvidenceModel {
  runId: string;
  command: string;
  generatedAt: string;
  environment: string;
  baseUrl: string;
  browsers: string[];
  counts: TestCounts;
  tests: TestView[];
  totals: { tests: number; steps: number; screenshots: number };
  gaps: string[]; // evidence that should exist but does not
}

export interface EvidenceInputs {
  rootDir: string;
  manifest: RunManifest;
  config: AutomationConfig;
  tests: FinalTest[];
  counts: TestCounts;
  results: ExecutionResults | null;
  regression: ExecutionResults | null;
  specs: TestSpecDocument | null;
  secrets: readonly string[];
  now: Date;
}

function readAttemptLog(rootDir: string, attempt: Attempt) {
  const att = attempt.attachments.find((a) => a.name === STEP_LOG_ATTACHMENT);
  if (!att) return null;
  try {
    return parseStepLog(JSON.parse(readFileSync(path.join(rootDir, att.path), 'utf8')));
  } catch {
    return null;
  }
}

function attemptView(i: EvidenceInputs, label: string, a: Attempt, counters: { steps: number; screenshots: number }, gaps: string[], testId: string): AttemptView {
  const clean = (s: string) => redact(s, i.secrets);
  const stepLog = readAttemptLog(i.rootDir, a);
  // The log names its screenshots by attachment name; the attempt's attachment list says where Playwright put the file.
  const shown = new Set<string>();
  const imageFor = (name: string | null): string | null => {
    const att = name ? a.attachments.find((x) => x.name === name && x.contentType.startsWith('image/')) : undefined;
    if (!att) return null;
    const abs = path.join(i.rootDir, att.path);
    if (!existsSync(abs)) return null;
    shown.add(att.name);
    return abs;
  };
  const view: AttemptView = {
    label, status: a.status, durationMs: a.durationMs, errors: a.errors.map((e) => clean(e.message)),
    hasStepLog: stepLog !== null, steps: [], final: null, otherImages: [],
  };
  if (stepLog) {
    for (const s of stepLog.steps) {
      const image = imageFor(s.screenshot);
      counters.steps++;
      if (image) counters.screenshots++;
      else gaps.push(`${testId} (${label}) step ${s.index} "${s.title}": no screenshot${s.screenshotNote ? ` — ${s.screenshotNote}` : ''}`);
      view.steps.push({
        index: s.index, depth: s.depth, title: clean(s.title), status: s.status, startedAt: s.startedAt, durationMs: s.durationMs,
        error: s.error ? clean(s.error) : null, image, note: image ? null : clean(s.screenshotNote ?? 'no screenshot was recorded'),
      });
    }
    const finalImage = imageFor(stepLog.final.screenshot);
    if (finalImage) counters.screenshots++;
    view.final = { status: stepLog.final.status, image: finalImage, note: finalImage ? null : clean(stepLog.final.screenshotNote ?? 'no screenshot was recorded') };
  } else {
    gaps.push(`${testId} (${label}): no step evidence was recorded (the test may not import fixtures/test, fixtures/test may predate the evidence-pdf reporter (run init --update), or the reporter was not configured when it ran)`);
  }
  // Screenshots Playwright attached on its own (evidence.screenshot mode), except the ones this report already shows.
  for (const att of a.attachments) {
    if (!att.contentType.startsWith('image/')) continue;
    if (shown.has(att.name)) continue;
    const abs = path.join(i.rootDir, att.path);
    if (existsSync(abs)) view.otherImages.push({ name: clean(att.name), image: abs });
  }
  return view;
}

export function buildEvidenceModel(i: EvidenceInputs): EvidenceModel {
  const specById = new Map<string, TestSpec>((i.specs?.specs ?? []).map((s) => [s.id, s]));
  const initial = new Map<string, TestResult>((i.results?.tests ?? []).map((t) => [t.key, t]));
  const regression = new Map<string, TestResult>((i.regression?.tests ?? []).map((t) => [t.key, t]));
  const counters = { steps: 0, screenshots: 0 };
  const gaps: string[] = [];

  const tests = i.tests.map((ft, n): TestView => {
    const spec = specById.get(ft.testId) ?? null;
    const attempts: AttemptView[] = [];
    const initialResult = initial.get(ft.key);
    const several = (initialResult?.attempts.length ?? 0) > 1;
    for (const a of initialResult?.attempts ?? []) {
      attempts.push(attemptView(i, `Initial run · attempt ${a.retry + 1}${several ? ` of ${initialResult!.attempts.length}` : ''}`, a, counters, gaps, ft.testId));
    }
    const regressionResult = regression.get(ft.key);
    for (const a of regressionResult?.attempts ?? []) {
      attempts.push(attemptView(i, `Regression run · attempt ${a.retry + 1}`, a, counters, gaps, ft.testId));
    }
    const file = initialResult?.file ?? null;
    return {
      anchor: `t${n + 1}`,
      testId: ft.testId, title: ft.title.startsWith(`[${ft.testId}]`) ? ft.title.slice(ft.testId.length + 2).trim() : ft.title,
      module: spec?.module ?? null, project: ft.project, outcome: ft.outcome, category: ft.category, note: ft.note,
      file: file ? `${file}${initialResult!.line ? `:${initialResult!.line}` : ''}` : null,
      priority: spec?.priority ?? null, tags: spec?.tags ?? [], preconditions: spec?.preconditions ?? [],
      plannedSteps: (spec?.steps ?? []).map((s) => ({ index: s.index, action: s.action, expected: s.expected })),
      expectedResults: spec?.expectedResults ?? [],
      attempts,
    };
  });

  return {
    runId: i.manifest.runId, command: i.manifest.command, generatedAt: i.now.toISOString(),
    environment: i.config.app.environment, baseUrl: i.config.app.baseUrl, browsers: i.config.browsers,
    counts: i.counts, tests,
    totals: { tests: tests.length, steps: counters.steps, screenshots: counters.screenshots },
    gaps,
  };
}

// ---- HTML ----

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const e = escapeHtml;

const seconds = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`);
const stamp = (iso: string): string => (iso && !Number.isNaN(Date.parse(iso)) ? `${new Date(iso).toISOString().slice(0, 19).replace('T', ' ')} UTC` : '');

const OUTCOME_LABEL: Record<string, string> = { passed: 'PASSED', failed: 'FAILED', flaky: 'FLAKY', healed: 'HEALED', blocked: 'BLOCKED', skipped: 'SKIPPED' };

const CSS = `
:root { --ink:#1b2430; --muted:#5b6675; --line:#d5dbe3; --soft:#f4f6f9; --pass:#1e7a3c; --fail:#b3261e; --warn:#a15c00; --heal:#1f5fa8; --idle:#5b6675; }
@page { size: A4; margin: 14mm 12mm 16mm 12mm; }
* { box-sizing: border-box; }
body { font: 9.5pt/1.4 "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); margin: 0; }
h1 { font-size: 22pt; margin: 0 0 2mm; } h2 { font-size: 14pt; margin: 0 0 2mm; } h3 { font-size: 10.5pt; margin: 5mm 0 1.5mm; }
.muted { color: var(--muted); } .mono { font-family: Consolas, "Courier New", monospace; }
.meta { display: grid; grid-template-columns: 34mm 1fr; gap: 1mm 4mm; margin: 4mm 0; } .meta dt { color: var(--muted); } .meta dd { margin: 0; }
.counts { display: flex; flex-wrap: wrap; gap: 2mm; margin: 3mm 0 5mm; }
.chip { border: 1px solid var(--line); border-radius: 2mm; padding: 1.5mm 3mm; min-width: 22mm; } .chip b { display: block; font-size: 14pt; }
table { border-collapse: collapse; width: 100%; } th, td { border-bottom: 1px solid var(--line); padding: 1.4mm 2mm; text-align: left; vertical-align: top; } th { background: var(--soft); font-weight: 600; }
a { color: inherit; }
.badge { display: inline-block; border-radius: 1.5mm; padding: 0 2mm; font-size: 8pt; font-weight: 700; color: #fff; background: var(--idle); letter-spacing: .02em; }
.passed { --c: var(--pass); } .failed { --c: var(--fail); } .flaky { --c: var(--warn); } .healed { --c: var(--heal); } .blocked, .skipped { --c: var(--idle); }
.badge.passed, .badge.failed, .badge.flaky, .badge.healed, .badge.blocked, .badge.skipped { background: var(--c); }
.test { break-before: page; }
.test-head { border-left: 2mm solid var(--c); padding-left: 3mm; margin-bottom: 3mm; }
.attempt { margin-top: 4mm; } .attempt > h3 { border-bottom: 1px solid var(--line); padding-bottom: 1mm; }
.step { break-inside: avoid; border: 1px solid var(--line); border-left: 1.5mm solid var(--c); border-radius: 1.5mm; margin: 2.5mm 0; padding: 2mm 3mm; }
.step-head { display: flex; gap: 3mm; align-items: baseline; } .step-head .num { font-weight: 700; white-space: nowrap; } .step-head .title { flex: 1; }
.step-head .dur { color: var(--muted); white-space: nowrap; font-size: 8.5pt; }
figure { margin: 2mm 0 0; } figure img { display: block; width: auto; height: auto; max-width: 100%; max-height: 100mm; border: 1px solid var(--line); }
figcaption { color: var(--muted); font-size: 8pt; margin-top: 1mm; }
.noimg { margin-top: 2mm; padding: 2mm; border: 1px dashed var(--line); color: var(--muted); font-size: 8.5pt; }
pre.err { white-space: pre-wrap; word-break: break-word; background: #fdf1f0; border: 1px solid #f0c9c5; color: #7a1b15; padding: 2mm; margin: 2mm 0 0; font-size: 8pt; }
.box { break-inside: avoid; border: 1px solid var(--line); border-radius: 1.5mm; padding: 2mm 3mm; background: var(--soft); margin: 2mm 0; }
.box ol, .box ul { margin: 1mm 0 0 5mm; padding: 0; }
.gaps { border-color: #e7c98a; background: #fff8e8; }
`;

// Turns a screenshot file into the value of an <img src>; null when it cannot be read.
export type ImageSource = (file: string) => string | null;

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

// Screenshots are embedded, so the HTML is one self-contained file: Chromium never has to open the (often very long,
// on Windows over MAX_PATH) evidence paths, and the report survives the run's evidence being pruned.
export const embedImage: ImageSource = (file) => {
  try {
    return `data:${MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'};base64,${readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
};

function figure(src: ImageSource, file: string | null, alt: string, caption: string | null, noImage: string): string {
  const url = file ? src(file) : null;
  return url
    ? `<figure><img src="${url}" alt="${e(alt)}">${caption ? `<figcaption>${e(caption)}</figcaption>` : ''}</figure>`
    : `<div class="noimg">No screenshot: ${e(noImage)}</div>`;
}

function stepCard(s: StepView, src: ImageSource): string {
  const pad = Math.min(s.depth, 4) * 6;
  const when = stamp(s.startedAt);
  const shot = figure(src, s.image, `Screenshot after step ${s.index}`, `Screenshot taken when step ${s.index} ended${when ? ` · started ${when}` : ''}`, s.note ?? 'none recorded');
  return `<div class="step ${s.status}" style="margin-left:${pad}mm">`
    + `<div class="step-head"><span class="num">Step ${s.index}</span><span class="title">${e(s.title)}</span>`
    + `<span class="badge ${s.status}">${s.status === 'passed' ? 'PASSED' : 'FAILED'}</span><span class="dur">${e(seconds(s.durationMs))}</span></div>`
    + shot
    + (s.error ? `<pre class="err">${e(s.error)}</pre>` : '')
    + `</div>`;
}

function attemptSection(a: AttemptView, src: ImageSource): string {
  const ok = a.status === 'passed';
  const parts = [`<div class="attempt"><h3>${e(a.label)} — <span class="${ok ? 'passed' : 'failed'}" style="color:var(--c)">${e(a.status.toUpperCase())}</span> <span class="muted">· ${e(seconds(a.durationMs))}</span></h3>`];
  if (!a.hasStepLog) parts.push('<div class="box gaps">No step evidence was recorded for this attempt, so there are no per-step screenshots.</div>');
  for (const s of a.steps) parts.push(stepCard(s, src));
  if (a.final) {
    const failed = a.final.status !== 'passed';
    parts.push(`<div class="step ${failed ? 'failed' : 'passed'}"><div class="step-head"><span class="num">${failed ? 'Failure state' : 'Final state'}</span>`
      + `<span class="title">The page when the test ended${failed ? ' (after the failure)' : ' (after the last assertion)'}</span></div>`
      + figure(src, a.final.image, 'Final state', null, a.final.note ?? 'none recorded')
      + `</div>`);
  }
  for (const o of a.otherImages) parts.push(`<div class="step"><div class="step-head"><span class="num">Attachment</span><span class="title">${e(o.name)}</span></div>${figure(src, o.image, o.name, null, 'could not be read')}</div>`);
  // The attempt's own error, unless a failed step above already shows it (the step error is the same message).
  const shownBySteps = a.steps.map((s) => s.error).filter((x): x is string => !!x);
  const same = (x: string, y: string) => x.startsWith(y.slice(0, 120)) || y.startsWith(x.slice(0, 120));
  const unshown = a.errors.filter((m) => !shownBySteps.some((s) => same(s, m)));
  if (!ok && unshown.length) parts.push(`<pre class="err">${unshown.map(e).join('\n\n')}</pre>`);
  parts.push('</div>');
  return parts.join('\n');
}

function testSection(t: TestView, src: ImageSource): string {
  const meta: [string, string][] = [];
  if (t.module) meta.push(['Module', t.module]);
  meta.push(['Browser project', t.project]);
  if (t.priority) meta.push(['Priority', t.priority]);
  if (t.tags.length) meta.push(['Tags', t.tags.join(', ')]);
  if (t.file) meta.push(['Test file', t.file]);
  if (t.category) meta.push(['Failure category', t.category]);
  const verdict = t.outcome === 'passed' ? 'The test passed, so each expected result below was asserted successfully.'
    : t.outcome === 'blocked' ? 'The test did not run, so none of these expected results was verified.'
      : `Overall result: ${OUTCOME_LABEL[t.outcome] ?? t.outcome}. See the attempts above for the step where it diverged.`;
  return `<section class="test ${t.outcome}" id="${t.anchor}">`
    + `<div class="test-head"><h2><span class="mono">[${e(t.testId)}]</span> ${e(t.title)} <span class="badge ${t.outcome}">${e(OUTCOME_LABEL[t.outcome] ?? t.outcome)}</span></h2>`
    + (t.note ? `<div class="muted">${e(t.note)}</div>` : '')
    + `<dl class="meta">${meta.map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join('')}</dl></div>`
    + (t.preconditions.length ? `<div class="box"><b>Preconditions</b><ul>${t.preconditions.map((p) => `<li>${e(p)}</li>`).join('')}</ul></div>` : '')
    + (t.plannedSteps.length
      ? `<div class="box"><b>Steps in the test case</b><ol>${t.plannedSteps.map((s) => `<li>${e(s.action)}${s.expected ? ` <span class="muted">→ ${e(s.expected)}</span>` : ''}</li>`).join('')}</ol></div>`
      : '')
    + `<h3>Execution evidence</h3>`
    + (t.attempts.length ? t.attempts.map((a) => attemptSection(a, src)).join('\n') : '<div class="box gaps">This test was not executed, so there is no step evidence.</div>')
    + (t.expectedResults.length
      ? `<div class="box"><b>Expected result${t.expectedResults.length > 1 ? 's' : ''}</b><ul>${t.expectedResults.map((x) => `<li>${e(x)}</li>`).join('')}</ul><div class="muted">${e(verdict)}</div></div>`
      : '')
    + `</section>`;
}

// The document in pieces (head + cover, one section per test, tail) so a large report can be written without ever
// holding every embedded screenshot in one string.
export function* evidenceHtmlParts(m: EvidenceModel, src: ImageSource = embedImage): Generator<string> {
  const c = m.counts;
  const chip = (label: string, n: number, cls: string) => `<div class="chip ${cls}"><b style="color:var(--c, var(--ink))">${n}</b>${label}</div>`;
  const toc = m.tests.map((t) => {
    const last = t.attempts.at(-1);
    return `<tr><td class="mono">${e(t.testId)}</td><td><a href="#${t.anchor}">${e(t.title)}</a></td><td>${e(t.module ?? '')}</td>`
      + `<td><span class="badge ${t.outcome}">${e(OUTCOME_LABEL[t.outcome] ?? t.outcome)}</span></td><td>${last ? last.steps.length : 0}</td></tr>`;
  }).join('');
  yield `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Test evidence report ${e(m.runId)}</title><style>${CSS}</style></head>
<body>
<section class="cover">
<h1>Test evidence report</h1>
<div class="muted">Every executed step with the screenshot taken when it ended.</div>
<dl class="meta">
<dt>Run</dt><dd class="mono">${e(m.runId)} · /${e(m.command)}</dd>
<dt>Generated</dt><dd>${e(stamp(m.generatedAt))}</dd>
<dt>Environment</dt><dd>${e(m.environment)} · ${e(m.baseUrl)}</dd>
<dt>Browsers</dt><dd>${e(m.browsers.join(', '))}</dd>
<dt>Contents</dt><dd>${m.totals.tests} test(s), ${m.totals.steps} step(s), ${m.totals.screenshots} screenshot(s)</dd>
</dl>
<div class="counts">${chip('Total', c.total, '')}${chip('Passed', c.passed, 'passed')}${chip('Failed', c.failed, 'failed')}${chip('Flaky', c.flaky, 'flaky')}${chip('Healed', c.healed, 'healed')}${chip('Blocked', c.blocked, 'blocked')}${chip('Skipped', c.skipped, 'skipped')}</div>
<p class="muted">Flaky tests passed only after a retry and are not counted as passed. Times are UTC. Screenshots show the page exactly as rendered, so data typed into visible fields appears in them.</p>
${m.gaps.length ? `<div class="box gaps"><b>Evidence gaps (${m.gaps.length})</b><ul>${m.gaps.slice(0, 40).map((g) => `<li>${e(g)}</li>`).join('')}${m.gaps.length > 40 ? `<li>… and ${m.gaps.length - 40} more</li>` : ''}</ul></div>` : ''}
<h3>Tests</h3>
<table><thead><tr><th>ID</th><th>Test</th><th>Module</th><th>Result</th><th>Steps</th></tr></thead><tbody>${toc}</tbody></table>
</section>`;
  for (const t of m.tests) yield testSection(t, src);
  yield '</body></html>';
}

export function renderEvidenceHtml(m: EvidenceModel, src: ImageSource = embedImage): string {
  return `${[...evidenceHtmlParts(m, src)].join('\n')}\n`;
}

function writeEvidenceHtml(file: string, m: EvidenceModel, src: ImageSource): void {
  const fd = openSync(file, 'w');
  try {
    for (const part of evidenceHtmlParts(m, src)) writeSync(fd, `${part}\n`);
  } finally {
    closeSync(fd);
  }
}

// ---- PDF ----

export interface PdfRender {
  ok: boolean;
  missing?: 'playwright' | 'browser'; // the tooling is not installed (not a defect in the report)
  output: string;
}
export interface PdfRenderer {
  (rootDir: string, htmlFile: string, pdfFile: string, footer: string): PdfRender;
}

export function renderToolPath(): string {
  return path.join(import.meta.dirname, '..', 'tools', 'render-pdf.ts');
}

export const defaultPdfRenderer: PdfRenderer = (rootDir, htmlFile, pdfFile, footer) => {
  const r = spawnSync(process.execPath, [renderToolPath(), '--root', rootDir, '--html', htmlFile, '--pdf', pdfFile, '--footer', footer], {
    cwd: rootDir, encoding: 'utf8', windowsHide: true, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024,
  });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  let reason: string | undefined;
  for (const line of text.split('\n').reverse()) {
    try { reason = (JSON.parse(line) as { reason?: string }).reason; break; } catch { /* not the tool's JSON line */ }
  }
  if (r.status === 0) return { ok: true, output: text.slice(-2000) };
  return { ok: false, missing: reason === 'playwright_missing' ? 'playwright' : reason === 'browser_missing' ? 'browser' : undefined, output: (r.error ? `${r.error.message}\n` : '') + text.slice(-2000) };
};

export function evidenceReportDir(rootDir: string, runId: string): string {
  assertRunId(runId);
  return path.join(rootDir, REPORTS_DIR, runId, EVIDENCE_REPORT_DIR);
}

// Writes the HTML, renders the PDF and verifies the result. Never throws: a failure is reported as a status.
export function buildEvidenceReport(i: EvidenceInputs, render: PdfRenderer = defaultPdfRenderer, src: ImageSource = embedImage): ReporterStatus {
  const name = 'evidence-pdf' as const;
  const outDir = evidenceReportDir(i.rootDir, i.manifest.runId);
  const htmlFile = path.join(outDir, EVIDENCE_HTML);
  const pdfFile = path.join(outDir, EVIDENCE_PDF);
  try {
    mkdirSync(outDir, { recursive: true });
    rmSync(pdfFile, { force: true });
    const model = buildEvidenceModel(i);
    writeEvidenceHtml(htmlFile, model, src);
    const r = render(i.rootDir, htmlFile, pdfFile, `Run ${i.manifest.runId}`);
    if (!r.ok) {
      return {
        name, status: r.missing ? 'missing_dependency' : 'failed', path: null,
        detail: r.missing === 'browser' ? 'Chromium is required to render the PDF and is not installed (install needs your approval)'
          : r.missing === 'playwright' ? '@playwright/test is required to render the PDF and is not installed in the project'
            : `PDF rendering failed: ${r.output.split('\n').filter(Boolean).slice(-3).join(' | ') || 'no output'}`,
      };
    }
    const size = existsSync(pdfFile) ? statSync(pdfFile).size : 0;
    const header = size > 0 ? readFileSync(pdfFile).subarray(0, 5).toString('latin1') : '';
    if (header !== '%PDF-') return { name, status: 'failed', path: null, detail: 'the renderer finished but produced no valid PDF' };
    const mb = size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
    const gap = model.gaps.length ? `; ${model.gaps.length} evidence gap(s) listed on the cover page` : '';
    return { name, status: 'generated', path: toPosixRelative(i.rootDir, pdfFile), detail: `${model.totals.tests} tests, ${model.totals.steps} steps, ${model.totals.screenshots} screenshots, ${mb}${gap}` };
  } catch (err) {
    return { name, status: 'failed', path: null, detail: `evidence report failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
