# automation-builder plugin

Agentic Playwright pipeline for Claude Code with on-disk, resumable run state.

Install: `/plugin marketplace add akhilvn-crypto/automation-builder` then `/plugin install automation-builder@automation-builder-marketplace`.

## Commands

| Command | Does |
|---|---|
| `/automation-builder:init [--language typescript|javascript] [--update] [--with-demo] [--with-pipeline-tests] [--force]` | asks TypeScript or JavaScript, then scaffolds (or updates/migrates) `automation/` (framework) and `dependencies/` (pipeline); installs nothing |
| `/automation-builder:playwright-pipeline [path] \| resume [<run-id>]` | full 13-stage pipeline |
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
  input/test-cases/                          your Markdown / CSV test cases
  runs/<run-id>/                             per-run manifest, specs, exploration, healing log, summary (git-ignored)
  state/                                     scaffold.json, dependency-log.json
  package.json  tsconfig.json  [demo/  engine-tests/]
```

- **Pipeline** (TypeScript, run directly by Node 24+ as `node dependencies/engine/cli/pipeline.ts`; refreshed by `--update`):
  `dependencies/engine/`, `dependencies/docs/`, `automation/playwright.config.*`, the tsconfigs.
- **Framework** (in the chosen language, yours to extend, created once): `fixtures/`, `pages/`, `helpers/`, `.env.example`, `README.md`.
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
- The template is organized as `template/dependencies` (engine, docs, demo, engine tests) and
  `template/framework/{common,typescript,javascript}`; the language-specific twins must stay functionally identical.

## Setup and installation approvals

On the first run the pipeline runs a read-only preflight, asks for missing settings (base URL, environment,
test-case path, browsers, evidence, reporters, auth) and saves them to `automation/config/automation.config.json`. The language is not asked again; it comes from the init choice. Every missing
dependency (`typescript` for TypeScript projects only, `@playwright/test`, browsers, `@playwright/cli`, Allure) is offered separately with the
exact command and installed only on an explicit yes, into `automation/`; decisions are logged in `dependencies/state/dependency-log.json`.

Secrets go in `automation/.env` (git-ignored; copy `.env.example`). Test cases go in `dependencies/input/test-cases/`. Run state lives in `dependencies/runs/<run-id>/`; reports and evidence in `automation/reports/<run-id>/` and `automation/test-results/<run-id>/`.
