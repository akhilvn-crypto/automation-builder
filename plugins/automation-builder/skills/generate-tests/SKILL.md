---
name: generate-tests
description: Parse test cases, explore the app as needed, then generate and review Playwright tests — without executing them.
argument-hint: "[test-case path] | resume <run-id>"
disable-model-invocation: true
---

# /automation-builder:generate-tests

> **Project setup:** if `src/cli/pipeline.ts` does not exist in the project root, stop and tell the user to run
> `/automation-builder:init` first (it scaffolds the framework; it installs nothing).

Same orchestrator role, shared modules and configuration as `/automation-builder:playwright-pipeline`; only the scope is smaller.

1. Start: `node src/cli/pipeline.ts run create --command generate-tests` (or `run resume <run-id>`).
   Out-of-scope stages are pre-marked `skipped`.
2. Run these stages exactly as described in [../playwright-pipeline/stages.md](../playwright-pipeline/stages.md):
   `preflight` → `configuration` → `input_validation` → `test_analysis` → `application_exploration` →
   `test_generation` → `script_review` → `finalization`.
   An optional path in `$ARGUMENTS` is passed as `--path` to `input validate` and to the test-analyst.
3. `finalization`: there is no summary to count, so just complete the stage after `node src/cli/pipeline.ts run finalize <runId>`.

Finish with: run id and status, generated files (from `generation-manifest.json`), excluded/blocked specs with
reasons, review findings still open (non-critical), and the next step: `/automation-builder:run-tests`.
