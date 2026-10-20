---
name: init
description: Scaffold the Automation Builder framework (pipeline CLI, config schema, fixtures, playwright.config.ts, tsconfigs, docs) into the current project, or update the engine files to this plugin's version. Installs nothing.
argument-hint: "[--update] [--with-demo] [--with-pipeline-tests] [--force]"
disable-model-invocation: true
---

# /automation-builder:init

Sets up the current project so the pipeline commands can run. The pipeline engine is TypeScript run directly by
Node 24+ from the project (`node src/cli/pipeline.ts`), and generated tests import the project's
`src/fixtures/test.ts`, so the framework files must live in the project, not only in the plugin.

## Steps

1. Show the user what will happen with a dry run first:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" --dry-run $ARGUMENTS
   ```

   Summarize `created`, `overwritten`, `merged` and `warnings` from the JSON. `overwritten` is non-empty only with
   `--update` (engine files: `src/cli`, `src/config`, `src/pipeline`, `src/tools`, `docs`, `playwright.config.ts`,
   tsconfigs) or `--force` (everything). If anything would be overwritten, or a warning says `package.json` "type" will
be set to `"module"` in an existing project, ask the user to confirm before step 2.

2. Run it for real (same arguments, without `--dry-run`):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" $ARGUMENTS
   ```

3. Report the result and the next step. Do **not** install anything here: `typescript`, `@types/node`,
   `@playwright/test` and browsers are offered one by one, with explicit approval, by the preflight/configuration
   stages of `/automation-builder:playwright-pipeline`.

## What it does

- Copies the framework into the project; existing files are skipped (never overwritten without `--update`/`--force`).
- Creates `tests/generated/`, `tests/handwritten/`, `src/pages/`, `input/test-cases/`, `config/`.
- Merges missing lines into `.gitignore` (secrets, `.env`, auth state, `output/runs/`, Playwright output).
- Adds missing npm scripts to `package.json` (creates it if absent; never adds dependencies).
- Appends the pipeline's hard rules to `CLAUDE.md` between `<!-- automation-builder:start/end -->` markers.
- Writes `config/.automation-builder-version` with the plugin version.

Optional: `--with-demo` adds the local demo app (`npm run demo:app`) and demo test cases; `--with-pipeline-tests`
adds the pipeline's own `node:test` suites (`npm run test:pipeline`).
