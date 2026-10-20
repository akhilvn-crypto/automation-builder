# automation-builder plugin

Agentic Playwright pipeline for Claude Code with on-disk, resumable run state.

Install: `/plugin marketplace add akhilvn-crypto/automation-builder` then `/plugin install automation-builder@automation-builder-marketplace`.

## Commands

| Command | Does |
|---|---|
| `/automation-builder:init [--update] [--with-demo] [--with-pipeline-tests] [--force]` | scaffold (or update) the framework in the current project; installs nothing |
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

The pipeline engine is TypeScript executed directly by Node 24+ (`node src/cli/pipeline.ts`), and generated tests
import the project's shared fixtures, so `/automation-builder:init` copies the framework from `template/` into your
project:

- **Engine** (plugin-owned, refreshed by `--update`): `src/cli`, `src/config`, `src/pipeline`, `src/tools`, `docs/`,
  `playwright.config.ts`, `tsconfig*.json`.
- **Framework** (yours to extend, created once): `src/fixtures`, `src/utils`, `.env.example`.
- Merges `.gitignore` lines, npm scripts and a delimited rules block in `CLAUDE.md`. Existing files are never
  overwritten without `--update` / `--force`.

## Setup and installation approvals

On the first run the pipeline runs a read-only preflight, asks for missing settings (base URL, environment,
test-case path, browsers, evidence, reporters, auth) and saves them to `config/automation.config.json`. Every missing
dependency (`typescript`, `@playwright/test`, browsers, `@playwright/cli`, Allure) is offered separately with the
exact command and installed only on an explicit yes; decisions are logged in `config/dependency-log.json`.

Secrets go in `.env` (git-ignored; copy `.env.example`). Run output lives in `output/runs/<run-id>/`.
