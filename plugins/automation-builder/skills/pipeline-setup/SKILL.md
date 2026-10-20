---
name: pipeline-setup
description: Preflight, approval-gated dependency installation, and persisted setup configuration for the Playwright pipeline. Use when running the preflight/configuration stages, when config/automation.config.json is missing or invalid, or when the user wants to change pipeline settings.
argument-hint: "[--reconfigure]"
---

# Pipeline setup

Resolves the `preflight` and `configuration` stages. All state goes through the CLI; never hand-edit
`automation/config/automation.config.json`, `dependencies/state/dependency-log.json` or a manifest.

CLI: `node dependencies/engine/cli/pipeline.ts <args>` (JSON on stdout; exit 0 ok, 2 validation failed/not ready, 1 error).
Run it from the project root. The project has two sibling folders: `automation/` (the Playwright framework — config
paths below are relative to it) and `dependencies/` (the pipeline engine, test-case input, run state). Packages install
into `automation/` (the only folder with a `package.json` dependency list and `node_modules`), so run every
`installCommand` as `cd automation && <installCommand>`.

## 1. Preflight (read-only)

Run `node dependencies/engine/cli/pipeline.ts preflight`. It never installs anything. Read `checks[]` and `config`.

- `node` status `error` → stop; the user must upgrade Node manually.
- Report a compact table: dependency, status, version, location, required.

## 2. Configuration

Run `node dependencies/engine/cli/pipeline.ts config check`.

Precedence, low → high: built-in defaults (non-material only: browsers=chromium, retries=1, timeout, healing cap=2) →
`automation/config/automation.config.json` → env vars `PW_BASE_URL`, `PW_ENVIRONMENT`, `PW_BROWSERS` (comma list),
`PW_WORKERS`, `PW_RETRIES` → explicit command arguments. Material choices (language, evidence, reporters, base URL,
input path, auth) are never defaulted silently.

- `status: "valid"` and no `--reconfigure` → **reuse it**. Show a 3–5 line summary. Do not re-ask.
- `absent` / `invalid` → ask **only** for the fields listed in `issues` (plus any the user wants to change).

Rules for asking (use AskUserQuestion; group independent choices into one call, max 4 questions):

- **Every question needs 2–4 options** (the tool rejects the whole call otherwise, and the user never sees it).
  When there is only one candidate value — e.g. a base URL found in a test case — never send it as a one-option
  question and never add a filler option. Ask a confirm question instead: *"Use `<value>` as `<field>`?"* with
  options *Yes, use as-is (Recommended)* and *No, I'll give a different value* (the user types it via Other).
  A genuinely free-text field with no candidate is asked in plain chat, not with AskUserQuestion.
- If a call is rejected with `InputValidationError`, do not repeat it unchanged: fix the offending question and
  re-ask. Do not re-ask questions the user already answered.

| Field | How to ask | Recommendation |
|---|---|---|
| `language` | **Do not ask here and do not infer it from tsconfig/devDependencies.** It was chosen by the user at `/automation-builder:init` and is recorded in `dependencies/state/scaffold.json` (preflight shows it as `scaffold.language`); the CLI seeds it into the config and rejects a different value. Only if `scaffold` is `null` (a folder not created by init) stop and tell the user to run `/automation-builder:init`. | chosen at init |
| `evidence.video` | off / on / retain-on-failure | retain-on-failure |
| `evidence.screenshot` | off / on / only-on-failure | only-on-failure |
| `evidence.trace` | off / on / on-first-retry / retain-on-failure | retain-on-failure |
| `reporters` | multiSelect (max 4 options): **html, allure, junit, evidence-pdf**. `json` is mandatory (pipeline state), so add it to the saved list yourself and do not offer it. Describe `evidence-pdf` as the *custom evidence report*: one PDF that lists every executed step with the screenshot taken when it ended, plus expected results and failures. Say what it costs: a screenshot per step for every test (passing ones too), and Chromium is used to print the PDF (no extra package). Never preselect it for the user | html + json + allure |
| `browsers` | multiSelect chromium/firefox/webkit | chromium |
| `app.baseUrl`, `app.environment` | Free text. **Never invent a URL.** Must be an authorized test environment. | — |
| `input.testCasesPath` | Path relative to `dependencies/`. **Don't ask in `/playwright-pipeline`:** the orchestrator already asked where the test cases are and imported them into `input/test-cases`, so use that. Ask only when no import happened (e.g. `/generate-tests` with the files already placed by hand) | `input/test-cases` |
| `auth.approach` | none / ui-login / storage-state; `credentialEnvVars` = env var **names** only. Don't ask for credentials or their names: those in the test cases are created in `automation/.env` by `specs parse` and redacted automatically, so `credentialEnvVars` may be `[]` | — |

Briefly mention storage cost: `on` for video/trace on every test is large; failure-only keeps evidence focused.
`evidence-pdf` is independent of `evidence.screenshot`: its per-step screenshots are always taken, so the screenshot mode
only controls Playwright's own failure screenshot. If the user picks `evidence-pdf` without `chromium` in `browsers`,
preflight adds a `browser:chromium` requirement (purpose "Render the evidence PDF"), approved like any other dependency.
Extent Reports: only offer after verifying a maintained Playwright integration exists; otherwise say so.

Write the candidate to a scratch JSON file, then `node dependencies/engine/cli/pipeline.ts config save --file <path>`.
Save as soon as the answers are in, before any install or exploration: a saved config is checkpointed on disk, so
a resumed run reuses it instead of asking again.
If exit code 2, show `issues` and re-ask only those fields. Never put secret values in the config —
secrets live in `automation/.env` (git-ignored); `automation/.env.example` lists names only.
The save also writes the choices into `automation/playwright.config.*` (a standard Playwright config the user may edit).
If the output says `playwrightConfig.status: "kept"`, the user edited that file by hand: tell them the new settings were
not applied to it (show `detail`) and let them choose between updating it themselves or `config render --force`.

## 3. Dependencies — one approval per dependency

Re-run preflight after configuration (required-ness depends on config). For **each** check with
`required: true` and `status: "missing"`, in this order: `typescript` (only required for a TypeScript scaffold), `@playwright/test`, `browser:*`,
`@playwright/cli`, `allure-playwright`, `allure-cli`:

1. Explain: what is missing, why (`purpose`), the exact `installCommand`, and that it is project-local and version-pinned.
2. Ask a yes/no question for **that dependency only**. Approval never extends to another dependency.
3. **Declined** →
   `node dependencies/engine/cli/pipeline.ts deps record --dependency <id> --action declined --reason "<purpose>" --run <runId>`,
   set the current stage `blocked` with the reason, and stop. Tell the user how to resume:
   `/automation-builder:playwright-pipeline resume <runId>` after installing or approving.
4. **Approved** → run exactly `installCommand` (from inside `automation/`), re-run preflight to verify the check is now `ok`, then
   `deps record --dependency <id> --action installed --version <verified> --cmd "<command>" --reason "<purpose>" --run <runId>`.
   If verification fails, report the output and mark the stage `failed`. Do not try alternatives.

Special cases:
- `@playwright/cli` found only **globally** is acceptable (`status: ok`). You may *offer* a project-local pinned
  install for reproducibility; it is optional.
- Before proposing any Allure install, check current official Allure guidance (Allure 3 CLI is the npm
  `allure` package; Allure 2 needs Java). Explain the runtime requirement in the question.
- After an approved `allure-playwright` install run `node dependencies/engine/cli/pipeline.ts config render`, so the
  reporter is added to `playwright.config.*` (it is listed there only once the adapter can be loaded).
- Before proposing the Playwright CLI install, check current official `@playwright/cli` guidance for the install
  command and compatibility with the installed `@playwright/test` version.

## 4. Done

Preflight `ready: true` and config `valid` ⇒ stage may complete. Otherwise the stage is `blocked`
(missing approval/info) or `failed` (an operation errored) — never `completed`.
