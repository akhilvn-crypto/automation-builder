// The "evidence-pdf" report: one PDF that shows, for every test, the steps that were executed, ONE video of the complete
// execution journey (embedded in the PDF itself), ONE screenshot of the final state, and the test case's expected results.
//
//   reports/<run-id>/evidence-report/evidence-report.html   the printable page (screenshots embedded, videos linked)
//   reports/<run-id>/evidence-report/evidence-report.pdf    the deliverable, with the videos stored inside it
//
// The step data comes from the step log the shared fixture writes while the tests run (step-evidence.ts); the video is
// Playwright's own per-test recording (evidence.video "on"). Building the model and the HTML is pure Node; only the HTML -> PDF
// step needs a browser, and goes through an injectable PdfRenderer (default: tools/render-pdf.ts, which uses the project's
// already-installed @playwright/test + Chromium). Chromium cannot embed media, so each video is placed afterwards by pdf-embed.ts
// (an appended PDF update that swaps the video's link for an embedded-file attachment) and then read back to verify it.

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AutomationConfig } from '../config/schema.ts';
import { toPosixRelative } from '../utils/fs.ts';
import { redact } from '../utils/redact.ts';
import { REPORTS_DIR, assertRunId } from './artifact-manager.ts';
import type { Attempt, ExecutionResults, TestResult } from './execution.ts';
import { embedFiles, listEmbeddedFiles, type EmbedItem } from './pdf-embed.ts';
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
}

// One recorded execution journey, stored inside the PDF as an attachment.
export interface VideoView {
  token: string; // "evidence-video-N": the marker in the video's link, which pdf-embed.ts finds in the printed PDF
  fileName: string; // the attachment's name inside the PDF
  file: string; // absolute path of the recording
  mime: string;
  bytes: number;
  source: string; // path relative to automation/, shown in the PDF as the fallback location
  href: string; // link target in the HTML (relative to the report folder)
}

export interface AttemptView {
  label: string; // "Initial run · attempt 1"
  status: string; // Playwright's status for the attempt
  durationMs: number;
  errors: string[];
  hasStepLog: boolean;
  steps: StepView[];
  final: { status: string; image: string | null; note: string | null } | null;
  videos: VideoView[]; // normally one: Playwright records one video per page
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
  totals: { tests: number; steps: number; screenshots: number; videos: number };
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

interface Counters { steps: number; screenshots: number; videos: number }
interface AttemptContext { testId: string; project: string; kind: 'initial' | 'regression'; reportDir: string; gaps: string[]; counters: Counters }

function attemptView(i: EvidenceInputs, label: string, a: Attempt, ctx: AttemptContext): AttemptView {
  const { counters, gaps, testId } = ctx;
  const clean = (s: string) => redact(s, i.secrets);
  const stepLog = readAttemptLog(i.rootDir, a);
  // The log names the final screenshot by attachment name; the attempt's attachment list says where Playwright put the file.
  const imageFor = (name: string | null): string | null => {
    const att = name ? a.attachments.find((x) => x.name === name && x.contentType.startsWith('image/')) : undefined;
    if (!att) return null;
    const abs = path.join(i.rootDir, att.path);
    return existsSync(abs) ? abs : null;
  };
  const view: AttemptView = {
    label, status: a.status, durationMs: a.durationMs, errors: a.errors.map((e) => clean(e.message)),
    hasStepLog: stepLog !== null, steps: [], final: null, videos: [],
  };
  if (stepLog) {
    for (const s of stepLog.steps) {
      counters.steps++;
      view.steps.push({
        index: s.index, depth: s.depth, title: clean(s.title), status: s.status, startedAt: s.startedAt, durationMs: s.durationMs,
        error: s.error ? clean(s.error) : null,
      });
    }
    const finalImage = imageFor(stepLog.final.screenshot);
    if (finalImage) counters.screenshots++;
    else gaps.push(`${testId} (${label}): no final-state screenshot${stepLog.final.screenshotNote ? ` — ${stepLog.final.screenshotNote}` : ''}`);
    view.final = { status: stepLog.final.status, image: finalImage, note: finalImage ? null : clean(stepLog.final.screenshotNote ?? 'no screenshot was recorded') };
  } else {
    gaps.push(`${testId} (${label}): no step evidence was recorded (the test may not import fixtures/test, fixtures/test may predate the evidence-pdf reporter (run init --update), or the reporter was not configured when it ran)`);
    // Without the fixture's screenshot, Playwright's own (evidence.screenshot) is the best available picture of the final state.
    const own = a.attachments.find((x) => x.contentType.startsWith('image/') && existsSync(path.join(i.rootDir, x.path)));
    if (own) {
      counters.screenshots++;
      view.final = { status: a.status, image: path.join(i.rootDir, own.path), note: null };
    }
  }
  // The journey: Playwright's own recording of the test (one per page; a test that opens a popup has more than one).
  const recordings = a.attachments.filter((x) => x.contentType.startsWith('video/') && existsSync(path.join(i.rootDir, x.path)));
  recordings.forEach((att, n) => {
    const file = path.join(i.rootDir, att.path);
    const token = `evidence-video-${++counters.videos}`;
    const ext = path.extname(file).toLowerCase() || '.webm';
    const fileName = `${testId}-${ctx.project}-${ctx.kind}-attempt${a.retry + 1}${recordings.length > 1 ? `-video${n + 1}` : ''}${ext}`;
    view.videos.push({
      token, fileName: fileName.replace(/[^A-Za-z0-9._-]/g, '_'), file, mime: att.contentType, bytes: statSync(file).size, source: att.path,
      href: `${path.relative(ctx.reportDir, file).split(path.sep).map(encodeURIComponent).join('/')}#${token}`,
    });
  });
  if (view.videos.length === 0) {
    gaps.push(`${testId} (${label}): no video was recorded (the report needs evidence.video "on", and a test that never opens a page has nothing to record)`);
  }
  return view;
}

export function buildEvidenceModel(i: EvidenceInputs): EvidenceModel {
  const specById = new Map<string, TestSpec>((i.specs?.specs ?? []).map((s) => [s.id, s]));
  const initial = new Map<string, TestResult>((i.results?.tests ?? []).map((t) => [t.key, t]));
  const regression = new Map<string, TestResult>((i.regression?.tests ?? []).map((t) => [t.key, t]));
  const counters: Counters = { steps: 0, screenshots: 0, videos: 0 };
  const gaps: string[] = [];
  const reportDir = evidenceReportDir(i.rootDir, i.manifest.runId);

  const tests = i.tests.map((ft, n): TestView => {
    const spec = specById.get(ft.testId) ?? null;
    const attempts: AttemptView[] = [];
    const initialResult = initial.get(ft.key);
    const several = (initialResult?.attempts.length ?? 0) > 1;
    const ctx = (kind: AttemptContext['kind']): AttemptContext => ({ testId: ft.testId, project: ft.project, kind, reportDir, gaps, counters });
    for (const a of initialResult?.attempts ?? []) {
      attempts.push(attemptView(i, `Initial run · attempt ${a.retry + 1}${several ? ` of ${initialResult!.attempts.length}` : ''}`, a, ctx('initial')));
    }
    const regressionResult = regression.get(ft.key);
    for (const a of regressionResult?.attempts ?? []) {
      attempts.push(attemptView(i, `Regression run · attempt ${a.retry + 1}`, a, ctx('regression')));
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
    totals: { tests: tests.length, steps: counters.steps, screenshots: counters.screenshots, videos: counters.videos },
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
table.steps { margin: 2mm 0; font-size: 9pt; } table.steps td { padding: 1mm 2mm; } table.steps tr { break-inside: avoid; }
table.steps td.n { width: 12mm; white-space: nowrap; color: var(--muted); } table.steps td.r { width: 22mm; white-space: nowrap; } table.steps td.d { width: 20mm; white-space: nowrap; color: var(--muted); text-align: right; }
table.steps tr.failed td { background: #fdf1f0; }
.video { break-inside: avoid; display: flex; gap: 4mm; align-items: center; border: 1px solid var(--line); border-left: 1.5mm solid var(--heal); border-radius: 1.5mm; margin: 2.5mm 0; padding: 2.5mm 3mm; background: var(--soft); }
.video .what { flex: 1; } .video .small { color: var(--muted); font-size: 8.5pt; }
a.play { display: block; flex: none; width: 10mm; height: 10mm; background: var(--heal); border-radius: 1.5mm; position: relative; text-decoration: none; }
a.play::after { content: ""; position: absolute; left: 3.6mm; top: 2.4mm; border-left: 4mm solid #fff; border-top: 2.6mm solid transparent; border-bottom: 2.6mm solid transparent; }
figure { margin: 2mm 0 0; } figure img { display: block; width: auto; height: auto; max-width: 100%; max-height: 90mm; border: 1px solid var(--line); }
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

const bytesLabel = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// The executed steps as a compact table (no per-step images: the video shows the journey).
function stepsTable(steps: StepView[]): string {
  const rows = steps.map((s) => {
    const pad = Math.min(s.depth, 4) * 5;
    return `<tr class="${s.status}"><td class="n">Step ${s.index}</td><td style="padding-left:${2 + pad}mm">${e(s.title)}</td>`
      + `<td class="r"><span class="badge ${s.status}">${s.status === 'passed' ? 'PASSED' : 'FAILED'}</span></td><td class="d">${e(seconds(s.durationMs))}</td></tr>`
      + (s.error ? `<tr class="${s.status}"><td></td><td colspan="3"><pre class="err">${e(s.error)}</pre></td></tr>` : '');
  }).join('');
  return `<table class="steps"><thead><tr><th>#</th><th>Executed step</th><th>Result</th><th style="text-align:right">Time</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// The link around the play icon is what pdf-embed.ts finds in the printed PDF and replaces by the embedded file.
function videoBox(v: VideoView, label: string): string {
  return `<div class="video"><a class="play" href="${e(v.href)}" title="Execution video"></a>`
    + `<div class="what"><b>Execution video</b> <span class="muted">· ${e(label)} · ${e(v.mime)} · ${e(bytesLabel(v.bytes))}</span>`
    + `<div>The complete journey of this test, from its first action to its final outcome, is stored inside this PDF as the attachment <span class="mono">${e(v.fileName)}</span>.</div>`
    + `<div class="small">Click (or double-click) the play icon, or open the viewer's Attachments panel, to play it. Same recording on disk: <span class="mono">${e(v.source)}</span></div></div></div>`;
}

function attemptSection(a: AttemptView, src: ImageSource): string {
  const ok = a.status === 'passed';
  const parts = [`<div class="attempt"><h3>${e(a.label)} — <span class="${ok ? 'passed' : 'failed'}" style="color:var(--c)">${e(a.status.toUpperCase())}</span> <span class="muted">· ${e(seconds(a.durationMs))}</span></h3>`];
  if (!a.hasStepLog) parts.push('<div class="box gaps">No step evidence was recorded for this attempt, so the executed steps are not listed.</div>');
  else if (a.steps.length) parts.push(stepsTable(a.steps));
  if (a.videos.length) a.videos.forEach((v, n) => parts.push(videoBox(v, a.videos.length > 1 ? `video ${n + 1} of ${a.videos.length}` : 'one video per test')));
  else parts.push('<div class="noimg">No video was recorded for this attempt.</div>');
  if (a.final) {
    const failed = a.final.status !== 'passed';
    parts.push(`<div class="step ${failed ? 'failed' : 'passed'}"><div class="step-head"><span class="num">${failed ? 'Failure state' : 'Final state'}</span>`
      + `<span class="title">The page when the test ended${failed ? ' (after the failure)' : ' (after the last assertion)'}</span></div>`
      + figure(src, a.final.image, 'Final state', null, a.final.note ?? 'none recorded')
      + `</div>`);
  }
  // The attempt's own error, unless a failed step above already shows it (the step error is the same message).
  const shownBySteps = a.steps.map((s) => s.error).filter((x): x is string => !!x);
  const bare = (s: string) => s.replace(/^Error:\s*/, ''); // Playwright prefixes the attempt's error, not the step's
  const same = (x: string, y: string) => bare(x).startsWith(bare(y).slice(0, 120)) || bare(y).startsWith(bare(x).slice(0, 120));
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
<div class="muted">For every test: the executed steps, one video of the complete execution, and one screenshot of the final state.</div>
<dl class="meta">
<dt>Run</dt><dd class="mono">${e(m.runId)} · /${e(m.command)}</dd>
<dt>Generated</dt><dd>${e(stamp(m.generatedAt))}</dd>
<dt>Environment</dt><dd>${e(m.environment)} · ${e(m.baseUrl)}</dd>
<dt>Browsers</dt><dd>${e(m.browsers.join(', '))}</dd>
<dt>Contents</dt><dd>${m.totals.tests} test(s), ${m.totals.steps} step(s), ${m.totals.screenshots} screenshot(s), ${m.totals.videos} video(s) embedded</dd>
</dl>
<div class="counts">${chip('Total', c.total, '')}${chip('Passed', c.passed, 'passed')}${chip('Failed', c.failed, 'failed')}${chip('Flaky', c.flaky, 'flaky')}${chip('Healed', c.healed, 'healed')}${chip('Blocked', c.blocked, 'blocked')}${chip('Skipped', c.skipped, 'skipped')}</div>
<p class="muted">Flaky tests passed only after a retry and are not counted as passed. Times are UTC. Screenshots and videos show the page exactly as rendered, so data typed into visible fields appears in them (password fields are masked in the screenshots, not in the videos).</p>
${m.totals.videos ? `<div class="box"><b>Playing the videos</b><ul>
<li>Each video is stored <b>inside this PDF</b> as a file attachment (the play icon in a test's Execution evidence section, and the viewer's Attachments panel). No separate file or link is needed.</li>
<li>Videos are WebM recordings made by Playwright. Open the icon in Adobe Acrobat / Reader (or Foxit, PDF-XChange) to extract and play them. Browser viewers (Chrome, Edge, Firefox) may not show attachments and none of them plays a video inside a page.</li>
<li>If your viewer cannot open attachments, the same recordings are in the project's test-results folder at the path printed under each video.</li>
</ul></div>` : ''}
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

export interface VideoEmbedding {
  embedded: number;
  placed: number; // videos whose play icon sits in the test's Execution evidence section
  warnings: string[];
}

// Stores every video inside the PDF, then reads the PDF back and checks that each file is in it, byte for byte. Throws if not.
export function embedVideosInPdf(pdfFile: string, videos: VideoView[]): VideoEmbedding {
  const items: EmbedItem[] = videos.map((v) => ({
    token: v.token, fileName: v.fileName, mime: v.mime, data: readFileSync(v.file),
    description: `Execution video (${v.fileName}, ${bytesLabel(v.bytes)})`,
  }));
  const result = embedFiles(readFileSync(pdfFile), items);
  const back = listEmbeddedFiles(result.pdf);
  const stored = new Map(back.files.map((f) => [f.name, f]));
  for (const [n, item] of items.entries()) {
    const name = item.fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    const file = stored.get(name);
    const sha = createHash('sha256').update(item.data).digest('hex');
    if (!file || file.size !== item.data.length || file.sha256 !== sha) {
      throw new Error(`the video for ${videos[n]!.fileName} is not stored in the PDF intact`);
    }
  }
  writeFileSync(pdfFile, result.pdf);
  const warnings: string[] = [];
  if (result.unplaced.length) warnings.push(`${result.unplaced.length} video(s) are attached to the PDF but have no play icon on a page`);
  if (!result.attachmentList) warnings.push('the PDF already had a /Names entry, so the videos are not in the Attachments panel list (their page icons still work)');
  return { embedded: result.embedded, placed: result.annotated, warnings };
}

// Writes the HTML, renders the PDF, embeds the videos and verifies the result. Never throws: a failure is reported as a status.
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
    let size = existsSync(pdfFile) ? statSync(pdfFile).size : 0;
    const header = size > 0 ? readFileSync(pdfFile).subarray(0, 5).toString('latin1') : '';
    if (header !== '%PDF-') return { name, status: 'failed', path: null, detail: 'the renderer finished but produced no valid PDF' };
    const videos = model.tests.flatMap((t) => t.attempts.flatMap((a) => a.videos));
    const notes: string[] = [];
    if (videos.length > 0) {
      try {
        const embedding = embedVideosInPdf(pdfFile, videos);
        notes.push(...embedding.warnings);
        size = statSync(pdfFile).size;
      } catch (err) {
        // The printed report is valid but would silently lack the videos it promises, so this is a failure, not a quiet downgrade.
        return { name, status: 'failed', path: null, detail: `the videos could not be embedded in the PDF: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    const gap = model.gaps.length ? `; ${model.gaps.length} evidence gap(s) listed on the cover page` : '';
    const warn = notes.length ? `; ${notes.join('; ')}` : '';
    return {
      name, status: 'generated', path: toPosixRelative(i.rootDir, pdfFile),
      detail: `${model.totals.tests} tests, ${model.totals.steps} steps, ${model.totals.screenshots} screenshots, ${model.totals.videos} videos embedded, ${bytesLabel(size)}${gap}${warn}`,
    };
  } catch (err) {
    return { name, status: 'failed', path: null, detail: `evidence report failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
