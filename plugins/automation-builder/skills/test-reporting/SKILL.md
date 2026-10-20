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

## The custom evidence report (`evidence-pdf`)
Chosen like any reporter. It is the one to offer when the user needs proof of what ran: **a PDF where each executed step is
shown next to the screenshot taken when that step ended**, per test and per attempt (retries and the regression run are
separate sections), followed by the test case's preconditions, steps and expected results, the error of any failed step,
and the final (or failure) state of the page. Cover page: run, environment, counts, contents, and a list of **evidence gaps**.

How it works:
- While tests run, the shared fixture (`fixtures/test.<ext>`, auto fixture `stepEvidence`) wraps `test.step`: every step
  records its outcome, duration and error (secrets masked) and a JPEG screenshot taken when the step ends, also when it fails.
  A final-state screenshot is taken when the test ends. This only happens when `reporters` contains `evidence-pdf`.
  Tests that import `test` from `@playwright/test` directly, or that never call `test.step`, have no step evidence:
  they appear in the report with a gap note instead of silently missing.
- `report build` reads those logs from the execution results, writes `automation/reports/<runId>/evidence-report/evidence-report.html`
  (one self-contained file, screenshots embedded) and prints it to `evidence-report.pdf` with the project's own
  `@playwright/test` + Chromium (`engine/tools/render-pdf.ts`). No extra package is needed.
- Status in `reporters`: `generated` (detail says tests/steps/screenshots/size, and the number of evidence gaps),
  `missing_dependency` (`@playwright/test` or Chromium not installed: ask approval for that dependency, record it, run
  `report build` again) or `failed` (detail has the reason). A gap does not fail the report, but **tell the user about it**.
- Screenshots show the page exactly as rendered, so values typed into visible fields appear in them; password fields are masked by the browser.

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

## Finalization
`node dependencies/engine/cli/pipeline.ts run finalize <runId>` copies the counts onto the manifest and applies `retention.keepRuns`
(only when configured). Then complete `finalization`. The final message shows: counts table, failure categories,
healing attempts and results, unresolved tests with reasons, report paths (`automation/reports/<runId>/initial/html/index.html`,
the Allure report, the evidence PDF `automation/reports/<runId>/evidence-report/evidence-report.pdf`,
`dependencies/runs/<runId>/summary.md`) and the evidence directory `automation/test-results/<runId>/`.

## Sensitive data
Runner logs and error messages are redacted using the values of `auth.credentialEnvVars`. Don't attach page dumps
containing personal data. Screenshots and videos follow the configured evidence modes, so prefer failure-only modes.
