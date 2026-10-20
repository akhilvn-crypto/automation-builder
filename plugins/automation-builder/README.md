# automation-builder plugin

Agentic Playwright pipeline for Claude Code with on-disk, resumable run state.

Install: `/plugin marketplace add akhilvn-crypto/automation-builder` then `/plugin install automation-builder@automation-builder-marketplace`.

## Commands

| Command | Does |
|---|---|
| `/automation-builder:init [--language typescript|javascript] [--update] [--with-demo] [--with-pipeline-tests] [--force]` | asks TypeScript or JavaScript, then scaffolds (or updates) the framework in `automation/`; installs nothing |
| `/automation-builder:playwright-pipeline [path] \| resume <run-id>` | full 13-stage pipeline |
| `/automation-builder:generate-tests [path] \| resume <run-id>` | parse → explore → generate → review (no execution) |
| `/automation-builder:run-tests [files...] \| resume <run-id>` | execute existing tests → triage → report (no edits) |
| `/automation-builder:heal-tests <run-id> \| resume <run-id>` | repair eligible script defects → regression check → report |

Knowledge skills (loaded automatically by Claude and the agents): `pipeline-setup`, `test-case-parser`,
`playwright-framework`, `application-exploration`, `test-data-management`, `execution-and-diagnostics`,
`auto-healing`, `test-reporting`.

Agents: `automation-builder:test-analyst`, `application-explorer`, `playwright-generator`, `test-reviewer`,
`test-executor`, `failure-healer`.

## How it fits together

Everything is scaffolded into one self-contained folder, **`automation/`** (own `package.json` and `node_modules`), so the
host project is untouched apart from a rules block in the root `CLAUDE.md`. `/automation-builder:init` **asks which
language** to use, TypeScript or JavaScript, and records the answer in `automation/config/scaffold.json`; it is never
defaulted and the folder cannot be switched in place.

```
automation/
  playwright.config.{ts,js}   fixtures/test.*   pages/BasePage.*   utils/test-data.*      framework (yours to extend)
  tests/{generated,handwritten,setup}   input/test-cases   config/   output/runs/          working folders
  engine/                                                                                   pipeline engine (plugin-owned)
  tsconfig.json + tsconfig.engine.json (TypeScript) | jsconfig.json (JavaScript)
  package.json  .gitignore  .env.example  README.md
```

- **Engine** (TypeScript, run directly by Node 24+ as `node automation/engine/cli/pipeline.ts`; refreshed by `--update`):
  `engine/`, `docs/`, `playwright.config.*`, tsconfigs.
- **Framework** (in the chosen language, yours to extend, created once): `fixtures/`, `pages/`, `utils/`, `.env.example`, `README.md`.
- Merges `.gitignore` lines and npm scripts inside `automation/`. Existing files are never overwritten without
  `--update` / `--force`.
- The template is organized as `template/engine` (shared) and `template/framework/{common,typescript,javascript}`; the
  language-specific twins must stay functionally identical.

## Setup and installation approvals

On the first run the pipeline runs a read-only preflight, asks for missing settings (base URL, environment,
test-case path, browsers, evidence, reporters, auth) and saves them to `automation/config/automation.config.json`. The language is not asked again; it comes from the init choice. Every missing
dependency (`typescript` for TypeScript projects only, `@playwright/test`, browsers, `@playwright/cli`, Allure) is offered separately with the
exact command and installed only on an explicit yes, into `automation/`; decisions are logged in `config/dependency-log.json`.

Secrets go in `automation/.env` (git-ignored; copy `.env.example`). Run output lives in `automation/output/runs/<run-id>/`.
