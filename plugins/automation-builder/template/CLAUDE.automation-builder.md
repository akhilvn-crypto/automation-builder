<!-- automation-builder:start -->
# Automation Builder — agentic Playwright pipeline (plugin: automation-builder)

Two sibling folders:

- **`automation/`** is the Playwright framework and nothing else (own `package.json`, `node_modules`), laid out as
  `pages/`, `tests/`, `helpers/`, `fixtures/`, `config/`, `reports/`, `test-results/` (+ `test-data/`, `auth/` when used).
- **`dependencies/`** is everything the pipeline needs that is not framework: `engine/`, `docs/`, `input/test-cases/`,
  `runs/` (run state), `state/`. It has no `node_modules`; dependencies install into `automation/`.

Never put pipeline files in `automation/` and never put framework files in `dependencies/`. Test files and page objects
are referred to relative to `automation/` ("tests/login.spec.ts"); test-case input and run artifacts relative to
`dependencies/` ("input/test-cases/login.md").
Commands: `/automation-builder:playwright-pipeline`, `/automation-builder:generate-tests`,
`/automation-builder:run-tests`, `/automation-builder:heal-tests`, `/automation-builder:init --update`.

## Hard rules

- **No unapproved installs.** Never install packages, browsers, CLIs or skills without an explicit yes for
  *that specific* dependency. Installs run inside `automation/` (`cd automation && npm install …`). Record every
  decision with `node dependencies/engine/cli/pipeline.ts deps record ...`.
- Never invent base URLs, credentials, test steps or expected results.
- Never write secrets to config, tests, logs or reports. Secrets live in `automation/.env` (git-ignored).
  Credentials/emails found in test cases are moved there by `specs parse` (don't ask the user for them); if a value is
  missing, tell the user which names to add to `automation/.env`, never ask for the value in chat.
- Never weaken/delete assertions or skip tests to get a pass. Retry-only passes are `flaky`, not `passed`.
- All pipeline state changes go through the CLI. Do not hand-edit manifests or the config file.
- The language (TypeScript or JavaScript) is the user's choice, made once at `/automation-builder:init` and stored in
  `dependencies/state/scaffold.json`. Never default it, never convert files to the other language.
- Keep `automation/` to the framework structure: no extra folders without a clear responsibility.

## Stack

- Node 24+ runs the pipeline engine (TypeScript, type stripping) directly. The engine is plugin-managed.
- The framework is TypeScript (`*.ts`, `npm run typecheck`) or JavaScript (`*.js`, JSDoc types) per the scaffold.
  TypeScript framework code uses only erasable syntax (no enums/namespaces/parameter properties) and imports local
  files with the `.ts` extension; JavaScript is ES modules and imports with `.js`.
- Package manager: npm, exact-pinned devDependencies.

## Layout

```
automation/
  pages/                 page objects: BasePage + one class per page/component
  tests/                 all tests. Files starting with "// @automation-builder:generated" are pipeline-owned (regenerated/healed);
                         every other test file is handwritten and never modified by the pipeline
  helpers/test-data.*    requireEnv, uniqueSuffix, redact (generic, app-agnostic utilities)
  fixtures/test.*        shared `test`/`expect` (auto diagnostics fixture) — tests import this, not @playwright/test
  config/                automation.config.json (approved non-secret choices)
  auth/                  only for auth.approach = storage-state: *.setup.* login + storage-state.json (git-ignored)
  test-data/             only when needed: non-sensitive data files
  reports/<run-id>/<label>/       reporter output (html/json/junit/allure); reports/adhoc/ for plain `npm test`
  test-results/<run-id>/<label>/  screenshots, video, traces; test-results/adhoc/ for plain `npm test`
  playwright.config.*    thin wrapper over dependencies/engine/config/playwright-settings.ts
dependencies/
  engine/                pipeline engine: cli/ config/ pipeline/ tools/ utils/ (update with /automation-builder:init --update)
  docs/                  test-case format and run-artifact reference
  input/test-cases/      Markdown / CSV test cases
  runs/<run-id>/         per-run manifest, specs, exploration, healing log, summary.json/md (git-ignored)
  state/                 scaffold.json (language), dependency-log.json
```

Stage completion is gated: `run stage … completed` validates the stage's required artifacts and fails with
`kind: "contract"`. Generated test titles start with `[<testId>] `.

## Configuration precedence (low → high)

1. Built-in defaults (non-material only: browsers=chromium, retries=1, timeout, healing cap=2)
2. `automation/config/automation.config.json`
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
