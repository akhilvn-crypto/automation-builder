---
name: test-reporting
description: Reporter configuration (HTML, JSON, JUnit, Allure), report generation and verification, final outcome rules and the run summary. Use for the report_generation and finalization stages or when changing reporters.
user-invocable: false
---

# Test reporting

## Where reporters are configured
Only in `config/automation.config.json` → `reporters` (changed through the pipeline-setup skill). The Playwright
reporter list is built in `src/config/playwright-settings.ts`. `json` is mandatory: the pipeline reads raw JSON, not HTML.
Allure is wired in only when `allure-playwright` is installed (approved); otherwise it is listed as `missing_dependency`.
Extent Reports is not wired in: there's no verified maintained Playwright integration. Offer it only after checking
for one, then add it the same way with separate approval.

## Build and verify
`node src/cli/pipeline.ts report build <runId>`:
- Computes the final outcome per test: `passed`, `failed`, `flaky` (retry-only pass), `healed` (failed, guarded fix,
  rerun passed, regression didn't fail), `blocked` (not runnable: needs clarification, excluded, no result),
  `skipped`. A regression failure overrides everything.
- `unresolved` = blocked + failures that aren't confirmed application defects.
- Verifies each selected reporter's output for the `initial` execution: `results.json` parses, `html/index.html`
  exists, `junit.xml` is JUnit XML; for Allure it runs `allure generate` (project-local CLI, else global) and checks `index.html`.
- Writes `reports/summary.json` and `reports/summary.md` **even when a reporter failed**, so the failure is visible.
- Exit 2 if any reporter failed or the run had a runner error. Then set `report_generation` to `failed` with the
  reason. Never claim a report exists unless `status: generated`.

## Finalization
`node src/cli/pipeline.ts run finalize <runId>` copies the counts onto the manifest and applies `retention.keepRuns`
(only when configured). Then complete `finalization`. The final message shows: counts table, failure categories,
healing attempts and results, unresolved tests with reasons, report paths (`reports/initial/html/index.html`,
the Allure report, `reports/summary.md`) and the evidence directory.

## Sensitive data
Runner logs and error messages are redacted using the values of `auth.credentialEnvVars`. Don't attach page dumps
containing personal data. Screenshots and videos follow the configured evidence modes, so prefer failure-only modes.
