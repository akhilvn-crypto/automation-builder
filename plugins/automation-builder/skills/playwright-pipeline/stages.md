# Stage playbook (shared by /automation-builder:playwright-pipeline, /automation-builder:generate-tests, /automation-builder:run-tests, /automation-builder:heal-tests)

CLI: `node dependencies/engine/cli/pipeline.ts …` (abbreviated `pl` below), run from the project root. JSON on stdout; exit 0 ok, 2 not ready/invalid, 1 error.

Two sibling folders. `automation/` is the Playwright framework only; `dependencies/` holds the engine, test-case input and
run state. Paths follow one rule:

| Kind | Relative to | Examples |
|---|---|---|
| test files, page objects, evidence, reports | `automation/` | `tests/x.spec.ts`, `test-results/<runId>/initial/…`, `reports/<runId>/initial/html/index.html` |
| test-case input (`input.testCasesPath`, `--path`, `--input`) | `dependencies/` | `input/test-cases`, `input/test-cases/login.md` |
| run artifacts (registered with `--artifact name=path`) | the run directory `dependencies/runs/<runId>/` | `test-specs.json`, `exploration/exploration.json`, `summary.json` |

A path written from the project root (`automation/tests/x.spec.ts`, `dependencies/input/test-cases/login.md`) is
accepted and normalized by the CLI. Package installs and `npx` tools run inside `automation/` (`cd automation && …`).
Generated code uses the language chosen at init (`language` in the run config).

Every stage follows the same pattern:

```
pl run stage <runId> <stage> running
…work…
pl run stage <runId> <stage> completed --artifact <name>=<relPath> [...]   # validated by the CLI
```

`completed` is refused (`kind: "contract"`) when a required artifact is missing or invalid; the error lists exactly
what's wrong. Fix the cause and complete again, or set `blocked`/`failed` with `--message`. Never hand-edit artifacts
to pass a contract.

- **blocked**: needs the user (missing info, declined install, clarification). Stop and say how to resume.
- **failed**: an operation errored (runner crash, report generation failed). Stop and show the error.
- A failing **test** is not a failing stage.

Delegate with the Agent tool (`subagent_type` = `automation-builder:<agent name>`, e.g. `automation-builder:test-analyst`). Give the agent the `runId` and only the inputs
listed. Agents return a summary. Verify their claims with the CLI validators before completing the stage.

| # | Stage | Inputs | Work | Complete with | Notes / failure |
|---|---|---|---|---|---|
| 1 | `preflight` | — | pipeline-setup skill §1 | — | Node too old → `failed` |
| 2 | `configuration` | preflight | pipeline-setup §2–3 (ask only missing fields, one approval per dependency); `pl run set-config <runId>` while running | — | install declined / info missing → `blocked` |
| 3 | `input_validation` | config, optional path arg | `pl input validate <runId> [--path p]` | `inputValidation=input-validation.json` | exit 2 → show `report.errors`, `blocked` |
| 4 | `test_analysis` | input-validation | Agent **test-analyst** | `testSpecs=test-specs.json` | relay its clarification questions to the user (AskUserQuestion). If they fix the source, re-run the stage. If no case is ready → `blocked`. Cases still needing clarification proceed as `blocked` tests |
| 5 | `application_exploration` | test-specs, config | Agent **application-explorer**. Before delegating, ask the user about any destructive step the specs require and pass the answer on | `exploration=exploration/exploration.json` | app unreachable/login fails → `blocked` (environment). `exploration.tool = none` → `skipped` with reason; the generator then marks locators low-confidence |
| 6 | `test_generation` | specs, exploration | Agent **playwright-generator** | `generationManifest=generation-manifest.json`, `generationReport=generation-report.md` | |
| 7 | `script_review` | generated files | Agent **test-reviewer**; if critical findings or typecheck errors → **playwright-generator** fixes (pass the findings) → reviewer re-checks. Max 3 rounds | `reviewReport=review-report.json` | still failing after 3 rounds → `failed`, list the findings |
| 8 | `execution` | reviewed tests | Agent **test-executor**, label `initial` (all generated tests, or the paths given) | `executionResults=execution-results.json` | `runnerError` → `failed` (not a test failure) |
| 9 | `failure_triage` | execution results (this run or `sourceRunId`) | `pl triage run <runId>`; if there are failures, Agent **failure-healer** Phase A (confirm classifications) | `failureAnalysis=failure-analysis.json` | no failures → still complete (empty analysis) |
| 10 | `healing` | failure analysis | no eligible failures → `skipped` ("no eligible script defects"). Else Agent **failure-healer** Phase B | `healingLog=healing-log.json` | the healer must run `pl heal finish` |
| 11 | `regression_validation` | healing log | nothing healed → `skipped`. Else Agent **test-executor**, label `regression`, `--test-file` for each healed file | `regressionResults=regression-results.json` | runner error → `failed` |
| 12 | `report_generation` | everything above | `pl report build <runId>` | `summary=summary.json`, `summaryMarkdown=summary.md` | exit 2 (reporter failed / runner error) → `failed` with the reporter details; the summary files still exist for the user |
| 13 | `finalization` | summary | `pl run finalize <runId>` | — | refused until counts are recorded |

Progress line after each stage: `[n/13] <stage> … <status> — <short note>`.

Final message: run id and status (`pl run show <runId>`); the counts table (total / passed / failed /
flaky(recovered) / healed / blocked / skipped / unresolved); failure categories; healing attempts; unresolved tests
with reasons; paths to `dependencies/runs/<runId>/summary.md`, the HTML report (`automation/reports/<runId>/initial/html/index.html`), the Allure report if any, and the evidence folder `automation/test-results/<runId>/`.
Never call a run successful unless its status is `completed`, and never present a flaky pass as a pass.
