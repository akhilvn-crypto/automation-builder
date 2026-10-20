---
name: heal-tests
description: Analyze failed tests from an earlier run, repair eligible script defects with bounded, guarded attempts, validate the repairs and report.
argument-hint: "<source-run-id> | resume <run-id>"
disable-model-invocation: true
---

# /automation-builder:heal-tests

> **Project setup:** if `dependencies/engine/cli/pipeline.ts` does not exist, stop and tell the user to run
> `/automation-builder:init` first (it scaffolds the framework; it installs nothing).

Same orchestrator role, shared modules and configuration as `/automation-builder:playwright-pipeline`.

1. Source run: `$ARGUMENTS`, or else the newest run from `node dependencies/engine/cli/pipeline.ts run list` whose
   `execution-results.json` has failed tests (check with `run show`). If there is none, say so and stop.
   Confirm the source run id with the user before healing.
2. Start: `node dependencies/engine/cli/pipeline.ts run create --command heal-tests --from-run <sourceRunId>` (or `run resume <run-id>`).
   The source run is read, never modified.
3. Run these stages exactly as described in [../playwright-pipeline/stages.md](../playwright-pipeline/stages.md):
   `preflight` → `configuration` → `failure_triage` → `healing` → `regression_validation` → `report_generation` →
   `finalization`.
   - `failure_triage`: `triage run <runId>` reads the source run's results automatically.
   - `healing`: **failure-healer** Phase B. The attempt limit is per test per run.
   - `regression_validation`: rerun every test in the healed files (label `regression`).

Finish with the stages.md summary, focusing on: healed tests (with diffs from `healing-log.json`), tests left failing
and why (application defects are not healed), and attempts used.
