# automation-builder plugin

Agentic Playwright pipeline for Claude Code with on-disk, resumable run state.

Install: `/plugin marketplace add akhilvn-crypto/automation-builder` then `/plugin install automation-builder@automation-builder-marketplace`.

## Commands

| Command | Does |
|---|---|
| `/automation-builder:init [--language typescript|javascript] [--update] [--with-demo] [--with-pipeline-tests] [--force]` | asks TypeScript or JavaScript, then scaffolds (or updates/migrates) `automation/` (framework) and `dependencies/` (pipeline); installs nothing |
| `/automation-builder:playwright-pipeline [path] \| resume [<run-id>]` | full 13-stage pipeline; first asks where your test cases are and converts them into `dependencies/input/test-cases/` |
| `/automation-builder:generate-tests [path] \| resume [<run-id>]` | parse → explore → generate → review (no execution) |
| `/automation-builder:run-tests [files...] \| resume [<run-id>]` | execute existing tests → triage → report (no edits) |
| `/automation-builder:heal-tests <run-id> \| resume [<run-id>]` | repair eligible script defects → regression check → report |

Knowledge skills (loaded automatically by Claude and the agents): `pipeline-setup`, `test-case-parser`,
`playwright-framework`, `application-exploration`, `test-data-management`, `execution-and-diagnostics`,
`auto-healing`, `test-reporting`.

Agents: `automation-builder:test-analyst`, `application-explorer`, `playwright-generator`, `test-reviewer`,
`test-executor`, `failure-healer`.

## How it fits together

`/automation-builder:init` creates two sibling folders in the project, so the framework stays clean:

- **`automation/`** is the Playwright framework **only**, laid out as in `playwright_framework_structure.md`. It has its own
  `package.json` and `node_modules`.
- **`dependencies/`** holds everything else the pipeline needs: the engine, docs, the test-case input, run state and
  bookkeeping. It has no `node_modules`.

The host project is otherwise untouched apart from a rules block in the root `CLAUDE.md`. The init command **asks which
language** to use, TypeScript or JavaScript, and records the answer in `dependencies/state/scaffold.json`; it is never
defaulted and the project cannot be switched in place.

```
automation/                                  framework only
  pages/            tests/            helpers/        mandatory
  fixtures/         config/                                   reports/<run-id>/  test-results/<run-id>/    supporting
  auth/  test-data/                          created only when a test needs them
  playwright.config.{ts,js}  tsconfig.json | jsconfig.json  package.json  .gitignore  .env.example  README.md
dependencies/                                not framework
  engine/  docs/                             pipeline engine and reference (plugin-owned)
  input/test-cases/                          your Markdown / CSV / Excel test cases
  runs/<run-id>/                             per-run manifest, specs, exploration, healing log, summary (git-ignored)
  state/                                     scaffold.json, dependency-log.json
  package.json  tsconfig.json  [demo/  engine-tests/]
```

- **Pipeline** (TypeScript, run directly by Node 24+ as `node dependencies/engine/cli/pipeline.ts`; refreshed by `--update`):
  `dependencies/engine/`, `dependencies/docs/`, the tsconfigs.
- **Framework** (in the chosen language, yours to extend, created once): `playwright.config.*`, `fixtures/`, `pages/`, `helpers/`, `.env.example`, `README.md`.
- **`playwright.config.{ts,js}`** is an ordinary Playwright config (the same shape `npm init playwright` creates) with your approved
  settings written in as plain values, so it reads and edits like any Playwright project. The pipeline fills it when settings are
  saved and leaves it alone once you edit it by hand (`node dependencies/engine/cli/pipeline.ts config render --force` rewrites it
  from `automation.config.json`). `--update` never overwrites it.
- Playwright's own output is framework output: reporter files go to `automation/reports/<run-id>/<label>/` and
  screenshots/video/traces to `automation/test-results/<run-id>/<label>/`. Pipeline state (manifest, specs, exploration,
  healing log, `summary.md`) stays in `dependencies/runs/<run-id>/`.
- Merges `.gitignore` lines and npm scripts. Existing files are never overwritten without `--update` / `--force`.
- **Tests** all live in `automation/tests/`. A test file written by the pipeline starts with `// @automation-builder:generated`;
  only such files are regenerated or healed. Delete the line to take a file over. Older `tests/generated` + `tests/handwritten`
  folders are flattened into `tests/` by `init`.
- **Migration:** a project scaffolded by 0.2.x (everything inside `automation/`) is detected by `init` and migrated:
  pipeline data moves to `dependencies/`, `utils/` becomes `helpers/`, `tests/setup/` becomes `auth/`, imports are rewritten, and
  the plugin-managed engine copies are replaced. `--dry-run` shows the plan first.
- **Evidence PDF:** choosing the `evidence-pdf` reporter makes the shared fixture screenshot every `test.step`; `report build`
  then writes `automation/reports/<run-id>/evidence-report/evidence-report.pdf` (every executed step next to its screenshot,
  per attempt, with expected results and failures) using the project's own Playwright + Chromium: no extra package.
  `--update` refreshes an unmodified older `fixtures/test.*` so existing projects can adopt it.
- The template is organized as `template/dependencies` (engine, docs, demo, engine tests) and
  `template/framework/{common,typescript,javascript}`; the language-specific twins must stay functionally identical.

## Setup and installation approvals

On the first run the pipeline runs a read-only preflight, asks for missing settings (base URL, environment,
test-case path, browsers, evidence, reporters, auth) and saves them to `automation/config/automation.config.json`. The language is not asked again; it comes from the init choice. Every missing
dependency (`typescript` for TypeScript projects only, `@playwright/test`, browsers, `@playwright/cli`, Allure) is offered separately with the
exact command and installed only on an explicit yes, into `automation/`; decisions are logged in `dependencies/state/dependency-log.json`.

Secrets go in `automation/.env` (git-ignored; copy `.env.example`). Credentials, usernames and emails found in your test cases are moved there automatically (`TEST_<NAME>` variables; `literal:<value>` opts a fake value out); you only fill in values the pipeline reports as missing. The pipeline asks where your test cases are (any path; Excel, CSV or Markdown in your own column layout), converts them to its Markdown format, one file per module, and saves them in `dependencies/input/test-cases/` (`input import --from <path>`; your original is never changed). Run state lives in `dependencies/runs/<run-id>/`; reports and evidence in `automation/reports/<run-id>/` and `automation/test-results/<run-id>/`.
