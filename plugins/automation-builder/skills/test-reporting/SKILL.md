---
name: test-reporting
description: Reporter configuration (HTML, JSON, JUnit, Allure), report generation and verification, final outcome rules and the run summary. Use for the report_generation and finalization stages or when changing reporters.
user-invocable: false
---

# Test reporting

## Where reporters are configured
Only in `automation/config/automation.config.json` → `reporters` (changed through the pipeline-setup skill). The Playwright
reporter list is written into `automation/playwright.config.*` (`config save`, or `config render` after changing it) unless that
file was edited by hand. Reporter output goes to the framework's
`automation/reports/<runId>/<label>/` (never into `dependencies/`). `json` is mandatory: the pipeline reads raw JSON, not HTML.
Allure is written into the config only when `allure-playwright` is installed (approved); otherwise it is listed as
`missing_dependency`. After installing it run `config render` (`exec run` also does this before each run).
Extent Reports is not wired in: there's no verified maintained Playwright integration. Offer it only after checking
for one, then add it the same way with separate approval.

## Report modes
`reporting.mode` (saved by pipeline-setup) bounds how much is produced; it only constrains what the user selected.

| Mode | Produces | For |
|---|---|---|
| `standard` | JSON + Playwright HTML; failure-focused screenshots/traces (no record-everything evidence) | default development runs |
| `full` | standard + Allure (approved) + video retained for failures | team testing and CI |
| `audit` | full + opt-in step screenshots (`reporting.stepScreenshots`) and the optional `evidence-pdf` reporter | formal sign-off |

`node dependencies/engine/cli/pipeline.ts config mode-preset <mode> [--step-screenshots] [--evidence-pdf]` shows what a mode would set;
`config report-plan` shows the configured reporters and the software they need (Allure adapter + CLI, Chromium for the PDF).
Missing software is proposed, never installed: ask for each item separately (pipeline-setup §3). Step screenshots and the PDF stay
opt-in because they slow runs and add many files.

## The custom evidence report (`evidence-pdf`)
Chosen like any reporter. It is the one to offer when the user needs proof of what ran: **a PDF with, per test and per attempt
(retries and the regression run are separate sections), the executed steps (result, duration, error), ONE video of the complete
execution journey stored inside the PDF, and ONE screenshot of the final (or failure) state**, followed by the test case's
preconditions, steps and expected results. Cover page: run, environment, counts, contents, how to play the videos, and a list of
**evidence gaps**.

How it works:
- Playwright records one video per test: the reporter requires `evidence.video: "on"` (config validation rejects anything else).
- While tests run, the shared fixture (`fixtures/test.<ext>`, auto fixture `stepEvidence`) wraps `test.step`: every step
  records its outcome, duration and error (secrets masked), and a final-state screenshot is taken when the test ends. This only
  happens when `reporters` contains `evidence-pdf` (audit mode with `stepScreenshots`). Password inputs and `reporting.maskSelectors`
  are masked in the screenshot (not in the video).
  Tests that import `test` from `@playwright/test` directly, or that never call `test.step`, have no step log:
  they appear in the report with a gap note instead of silently missing (Playwright's own screenshot stands in for the final state).
- `report build` reads those logs and the `video` attachments from the execution results, writes
  `automation/reports/<runId>/evidence-report/evidence-report.html` (one self-contained file, screenshots embedded, each video a
  play-icon link) and prints it to `evidence-report.pdf` with the project's own `@playwright/test` + Chromium
  (`engine/tools/render-pdf.ts`). Chromium cannot embed media, so `engine/pipeline/pdf-embed.ts` then appends a PDF update that
  turns each link into a file-attachment annotation holding the recording (and lists it in the Attachments panel); the result is read
  back and each video is compared byte for byte. No extra package is needed.
- The videos are WebM *file attachments*, not in-page players: Acrobat/Reader, Foxit and PDF-XChange open them; browser viewers may not show
  attachments. In-page playback would need H.264 MP4 and a transcoder (new dependency, not added). Fallback: the same recordings under
  `automation/test-results/<runId>/`, whose paths are printed in the PDF. Say this when handing the PDF over.
- Status in `reporters`: `generated` (detail says tests/steps/screenshots/videos embedded/size, and the number of evidence gaps),
  `missing_dependency` (`@playwright/test` or Chromium not installed: ask approval for that dependency, record it, run
  `report build` again) or `failed` (detail has the reason; also when the videos could not be embedded). A gap does not fail the report, but **tell the user about it**.
- Screenshots and videos show the page exactly as rendered, so values typed into visible fields appear in them; only password fields
  are masked, and only in the screenshot.

## Build and verify
`node dependencies/engine/cli/pipeline.ts report build <runId>`:
- Computes the final outcome per test: `passed`, `failed`, `flaky` (retry-only pass), `healed` (failed, guarded fix,
  rerun passed, regression didn't fail), `blocked` (not runnable: needs clarification, excluded, no result),
  `skipped`. A regression failure overrides everything.
- `unresolved` = blocked + failures that aren't confirmed application defects.
- Verifies each selected reporter's output for the `initial` execution: `results.json` parses, `html/index.html`
  exists, `junit.xml` is JUnit XML; for Allure it runs `allure generate` (project-local CLI, else global) and checks `index.html`;
  for `evidence-pdf` it builds the PDF from the `initial` (and `regression`) results and checks it is a PDF.
- Writes `summary.json` and `summary.md` into the run directory (`dependencies/runs/<runId>/`) **even when a reporter failed**, so the failure is visible.
- Exit 2 if any reporter failed or the run had a runner error. Then set `report_generation` to `failed` with the
  reason. Never claim a report exists unless `status: generated`.
- Keeps report generation apart from test results: `reportGeneration` (`ok`, `failed[]`, duration, files, bytes) answers "could the
  reports be built", `counts` answers "how did the tests do". A broken reporter never changes a count and a failing test never marks
  a reporter failed. Only the reporters in `reporters` are verified or built. Everything is derived from the normalized execution
  results (`generatedFrom` records their hashes); each reporter's duration, file count and size are in `summary.json`.

## Finalization
`node dependencies/engine/cli/pipeline.ts run finalize <runId>` copies the counts onto the manifest and applies `retention.keepRuns`
(only when configured). Then complete `finalization`. The final message shows: counts table, failure categories,
healing attempts and results, unresolved tests with reasons, report paths (`automation/reports/<runId>/initial/html/index.html`,
the Allure report, the evidence PDF `automation/reports/<runId>/evidence-report/evidence-report.pdf`,
`dependencies/runs/<runId>/summary.md`) and the evidence directory `automation/test-results/<runId>/`.

## Metrics
`run finalize` writes `metrics.json` into the run directory (derived from the manifest; failing to write it never blocks finalization);
`run metrics <runId>` shows it live: per-stage duration (summed over attempts), final status, attempts, interrupted attempts (process
died, distinct from an explicit `failed`), artifact count/size, execution retries and worker plan, healing attempts, report time,
cache hits/misses with the reason for every rebuild, and agent calls per stage (tokens only when reported). `run baseline [runId...]`
ranks stages by median completed duration. `run compare <baselineRunId> <candidateRunId>` compares two runs of the same suite: it first
checks that no test went missing or got worse (verdict `incorrect` otherwise, whatever the timing), then reports the per-stage time
difference. Metrics are evidence for choosing what to optimise, never inputs to a pass/fail decision.

## Sensitive data
Runner logs and error messages are redacted using the values of `auth.credentialEnvVars` (and the variables the pipeline created in `.env`), and credential-shaped text (authorization and cookie headers, JWTs, token/api-key pairs) is masked even when it is not a configured secret. Don't attach page dumps
containing personal data. Screenshots and videos follow the configured evidence modes, so prefer failure-only modes.
