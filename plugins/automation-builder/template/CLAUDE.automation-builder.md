<!-- automation-builder:start -->
# Automation Builder — agentic Playwright pipeline (plugin: automation-builder)

The whole test framework lives in **`automation/`**: a self-contained Playwright project (own `package.json`,
`node_modules`, config, tests, evidence). Paths below are relative to `automation/` unless they start with it.
Commands: `/automation-builder:playwright-pipeline`, `/automation-builder:generate-tests`,
`/automation-builder:run-tests`, `/automation-builder:heal-tests`, `/automation-builder:init --update`.

## Hard rules

- **No unapproved installs.** Never install packages, browsers, CLIs or skills without an explicit yes for
  *that specific* dependency. Installs run inside `automation/` (`cd automation && npm install …`). Record every
  decision with `node automation/engine/cli/pipeline.ts deps record ...`.
- Never invent base URLs, credentials, test steps or expected results.
- Never write secrets to config, tests, logs or reports. Secrets live in `automation/.env` (git-ignored).
- Never weaken/delete assertions or skip tests to get a pass. Retry-only passes are `flaky`, not `passed`.
- All pipeline state changes go through the CLI. Do not hand-edit manifests or the config file.
- The language (TypeScript or JavaScript) is the user's choice, made once at `/automation-builder:init` and stored in
  `config/scaffold.json`. Never default it, never convert files to the other language.

## Stack

- Node 24+ runs the pipeline engine (TypeScript, type stripping) directly. The engine is plugin-managed.
- The framework is TypeScript (`*.ts`, `npm run typecheck`) or JavaScript (`*.js`, JSDoc types) per the scaffold.
  TypeScript framework code uses only erasable syntax (no enums/namespaces/parameter properties) and imports local
  files with the `.ts` extension; JavaScript is ES modules and imports with `.js`.
- Package manager: npm, exact-pinned devDependencies.

## Layout (`automation/`)

```
engine/                pipeline engine: cli/ config/ pipeline/ tools/ utils/ (update with /automation-builder:init --update)
playwright.config.*    thin wrapper over engine/config/playwright-settings.ts
fixtures/test.*        shared `test`/`expect` (auto diagnostics fixture) — tests import this, not @playwright/test
pages/                 page objects: BasePage + one class per page/component
utils/test-data.*      requireEnv, uniqueSuffix, redact
tests/generated/       generator output only; tests/handwritten/ is never modified by the pipeline
tests/setup/           *.setup.* login for auth.approach = storage-state
config/                automation.config.json (approved non-secret choices), dependency-log.json, scaffold.json
input/test-cases/      Markdown / CSV test cases
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
