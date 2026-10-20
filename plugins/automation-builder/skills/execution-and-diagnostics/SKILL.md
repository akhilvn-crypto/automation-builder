---
name: execution-and-diagnostics
description: Running Playwright Test through the pipeline CLI, execution labels, normalized result files, evidence (screenshots, video, trace, diagnostics) and failure classification categories. Use when executing tests, reading results, or triaging failures.
user-invocable: false
---

# Execution and diagnostics

## Running
`node src/cli/pipeline.ts exec run <runId> --label <label> [--test-file f]... [--test-id ID]... [--project p]... [--retries n]`

- Spawns the project-local Playwright CLI with `PIPELINE_RUN_DIR`/`PIPELINE_LABEL`, so output goes to
  `reports/<label>/` (raw `results.json`, `html/`, `junit.xml`, `allure-results/`, `runner.log`) and
  `evidence/<label>/` (screenshots, videos, traces).
- Normalized results: `execution-results.json` (label `initial`), `regression-results.json` (`regression`),
  `reruns/<label>.json` (anything else, e.g. `heal-TC-2-1`). Evidence paths in them are project-relative.
- `--test-id` greps titles starting with `[ID]`. Healing reruns use `--retries 0`, so a retry can't mask the result.
- Exit 0 = the runner worked (tests may still have failed). Exit 2 = `runnerError` (config error, crash, no tests,
  missing browser). That is an environment/config problem, never a test result. The execution stage is then `failed`.

## Outcomes
`passed` (first attempt) · `failed` · `flaky` (failed, then passed on retry: **never** counted as passed) · `skipped`.
Result key = `<testId>@<project>`.

## Reading evidence
1. `errors[0].message` and the call log: what was awaited, and whether the locator resolved ("locator resolved to …").
2. Screenshot at failure: did the page load, is there an error banner or a login redirect?
3. Trace (`npx playwright show-trace <zip>`, or read actions/snapshots) for timing and navigation issues.
4. `diagnostics` attachment: console errors, page errors, failed requests, HTTP 5xx.

## Categories (`triage run`, then confirmed by the failure-healer)
| Category | Typical evidence | Heal? |
|---|---|---|
| `script_defect` | strict-mode violation; locator resolves to nothing while the control is visibly present under another name; script error | yes (high/medium confidence only) |
| `application_defect` | element found but value differs from the spec ("Expected … Received …"); control genuinely missing | no: keep failing, report |
| `environment_issue` | DNS/connection refused, 5xx, browser not installed | no |
| `test_data_or_precondition` | missing env var, expired auth state, missing seed data | no |
| `flaky_or_intermittent` | passed only on retry | no: report as flaky |
| `inconclusive` | no clear signal | no: report |

The heuristic is a starting point. Overrides need a rationale citing the evidence (`triage classify`).
