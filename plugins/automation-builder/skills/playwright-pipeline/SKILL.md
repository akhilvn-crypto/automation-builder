---
name: playwright-pipeline
description: Run the full agentic Playwright pipeline — preflight, setup, test analysis, exploration, generation, review, execution, triage, bounded healing, and reporting — with on-disk run state.
argument-hint: "[test-case path] | resume [<run-id>]"
disable-model-invocation: true
---

# /automation-builder:playwright-pipeline — orchestrator

> **Project setup:** if `dependencies/engine/cli/pipeline.ts` does not exist, stop and tell the user to run
> `/automation-builder:init` first (it scaffolds the framework; it installs nothing).

You (the main session) are the **pipeline orchestrator**. Orchestration runs in the main session, not in a
subagent, because it must ask the user setup/approval questions and delegate to stage subagents (subagents cannot
spawn subagents). This skill plays the `pipeline-orchestrator` role.

## Responsibilities and limits

- Own stage transitions; advance only after the CLI accepts a stage's outputs.
- Never invent test steps, expected results, base URLs or credentials.
- Never modify tests to force a pass. Never treat partial artifacts as valid.
- Pipeline state lives on disk. Use the CLI for every state change; never edit manifests or config by hand.
- Ask the user only for what is missing (pipeline-setup skill), one approval per dependency.

## Start or resume

- `$ARGUMENTS` starts with `resume` → continue a stopped run from its on-disk checkpoint:
  - `resume <run-id>` → `node dependencies/engine/cli/pipeline.ts run resume <run-id>`.
  - bare `resume` (no id) → `node dependencies/engine/cli/pipeline.ts run resume --command playwright-pipeline`, which picks the
    newest run that is `in_progress`, `blocked` or `failed` (never `completed`/`cancelled`).
  If `ok: false`, show the issues and stop (do not "fix" the manifest; with no resumable run, offer to start a new one).
  Otherwise show the `checkpoint` in 2–3 lines before doing anything: run id, stages already completed, the stage
  it resumes at and why it stopped (`reason`), and mention any `recovered` (interrupted) stages, which are re-run
  from scratch. If `others` is non-empty, say how many other resumable runs exist and that `resume <run-id>` picks
  a specific one (`run resumable` lists them). Then continue from `next`; completed stages are never repeated.
- Otherwise → `node dependencies/engine/cli/pipeline.ts run create --command playwright-pipeline` and note the `runId`. An optional
  test-case path in `$ARGUMENTS` (e.g. `dependencies/input/test-cases`; the CLI also accepts it relative to `dependencies/`) is passed as `--path` to `input validate` and to the test-analyst for this run only.

## Run the stages

Follow [stages.md](stages.md) for all 13 stages in order. It defines each stage's inputs, the agent to delegate to,
the artifacts to register, and the failure behaviour.

## Finish

Print the final summary described at the end of stages.md, plus the run directory `dependencies/runs/<runId>/` (summary.md inside) and the report folder `automation/reports/<runId>/`.
If the run stopped early, give the exact resume command: `/automation-builder:playwright-pipeline resume <runId>`.
