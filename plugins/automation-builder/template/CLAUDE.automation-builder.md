<!-- automation-builder:start -->
# Automation Builder — agentic Playwright pipeline (plugin: automation-builder)

Commands: `/automation-builder:playwright-pipeline`, `/automation-builder:generate-tests`,
`/automation-builder:run-tests`, `/automation-builder:heal-tests`, `/automation-builder:init --update`.

## Hard rules

- **No unapproved installs.** Never install packages, browsers, CLIs or skills without an explicit yes for
  *that specific* dependency. Record every decision with `node src/cli/pipeline.ts deps record ...`.
- Never invent base URLs, credentials, test steps or expected results.
- Never write secrets to config, tests, logs or reports. Secrets live in `.env` (git-ignored).
- Never weaken/delete assertions or skip tests to get a pass. Retry-only passes are `flaky`, not `passed`.
- All pipeline state changes go through the CLI. Do not hand-edit manifests or the config file.

## Stack

- Node 24+ runs TypeScript directly (type stripping) — use only erasable syntax (no enums/namespaces/
  parameter properties), and import local files with the `.ts` extension.
- Type check: `npm run typecheck`; framework + generated tests: `npm run typecheck:framework`.
- `tsconfig.json` = pipeline code (no Playwright import allowed); `tsconfig.framework.json` = `playwright.config.ts`,
  `src/fixtures`, `src/pages`, `src/tools`, generated tests.

## Layout

```
src/cli/ src/config/ src/pipeline/ src/tools/   pipeline engine (managed by the plugin; update with /automation-builder:init --update)
src/fixtures/test.ts   shared `test`/`expect` (auto diagnostics fixture)
src/utils/             fs.ts, test-data.ts (requireEnv, uniqueSuffix, redact)
playwright.config.ts   thin wrapper over src/config/playwright-settings.ts
tests/generated/       generator output only; tests/handwritten/ is never modified by the pipeline
config/                automation.config.json (approved non-secret choices), dependency-log.json
output/runs/<id>/      per-run manifest and artifacts (git-ignored)
```

Stage completion is gated: `run stage … completed` validates the stage's required artifacts and fails with
`kind: "contract"`. Generated test titles start with `[<testId>] `.

## Configuration precedence (low → high)

1. Built-in defaults (non-material only: browsers=chromium, retries=1, timeout, healing cap=2)
2. `config/automation.config.json`
3. Env vars: `PW_BASE_URL`, `PW_ENVIRONMENT`, `PW_BROWSERS` (comma list), `PW_WORKERS`, `PW_RETRIES`
4. Explicit command arguments

Material choices (language, evidence, reporters, base URL, input path, auth) are never defaulted silently.

## Orchestration

The orchestrator runs in the **main session** via `/automation-builder:playwright-pipeline` (not a subagent),
because it asks setup/approval questions and delegates to the stage subagents (`automation-builder:test-analyst`,
`automation-builder:application-explorer`, `automation-builder:playwright-generator`,
`automation-builder:test-reviewer`, `automation-builder:test-executor`, `automation-builder:failure-healer`).
Stage agents return questions/blockers to the orchestrator instead of asking the user.
<!-- automation-builder:end -->
