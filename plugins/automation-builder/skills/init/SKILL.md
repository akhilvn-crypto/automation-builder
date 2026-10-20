---
name: init
description: Scaffold the Automation Builder framework into the automation/ folder of the current project — a self-contained Playwright project in the language the user picks (TypeScript or JavaScript) plus the pipeline engine — or update the engine files to this plugin's version. Installs nothing.
argument-hint: "[--language typescript|javascript] [--update] [--with-demo] [--with-pipeline-tests] [--force]"
disable-model-invocation: true
---

# /automation-builder:init

Sets up the current project so the pipeline commands can run. Everything goes into **`automation/`** (its own
`package.json`, `node_modules`, config, tests and evidence), so the host project's own files are untouched apart from
a rules block in the root `CLAUDE.md`. The pipeline engine is TypeScript run directly by Node 24+
(`node automation/engine/cli/pipeline.ts`); the Playwright framework around it is TypeScript **or** JavaScript, as the
user chooses.

## Steps

1. **Language — ask, never default.**
   - If `automation/config/scaffold.json` exists, the language was already chosen (read `language` from it); do not
     ask and do not pass `--language`. It cannot be changed in place.
   - Otherwise, unless `$ARGUMENTS` already contains `--language`, ask with AskUserQuestion: *"Which language should
     the Playwright framework and generated tests use?"* with options **TypeScript (Recommended)** — typed
     fixtures/page objects, compile-time checks of generated tests (needs the `typescript` dev dependency) — and
     **JavaScript** — plain ES modules with JSDoc types, no compiler. Say that the choice is fixed for the folder.
   - Pass the answer as `--language typescript|javascript`.

2. Show what will happen with a dry run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" --dry-run --language <choice> $ARGUMENTS
   ```

   Summarize `created`, `overwritten`, `merged` and `warnings` from the JSON. `overwritten` is non-empty only with
   `--update` (engine files: `engine/`, `docs/`, `playwright.config.*`, `tsconfig*.json`/`jsconfig.json`) or
   `--force` (everything). If anything would be overwritten, or a warning mentions an existing `automation/package.json`
   problem or an older root-level install, tell the user and ask to confirm before step 3.
   Exit code 2 with `needsInput: "language"` means step 1 was skipped.

3. Run it for real (same arguments, without `--dry-run`):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" --language <choice> $ARGUMENTS
   ```

4. Report the result and the next step. Do **not** install anything here: `typescript` (TypeScript projects only),
   `@types/node`, `@playwright/test` and browsers are offered one by one, with explicit approval, by the
   preflight/configuration stages of `/automation-builder:playwright-pipeline`. They install into `automation/`.

## What it creates (inside `automation/`)

```
playwright.config.{ts|js}  fixtures/test.*  pages/BasePage.*  utils/test-data.*   the framework (yours to extend)
tsconfig.json + tsconfig.engine.json  (TypeScript)   or   jsconfig.json  (JavaScript)
engine/  docs/                                            the pipeline engine and reference (plugin-managed)
tests/generated  tests/handwritten  tests/setup  input/test-cases  config/        working folders
package.json  .gitignore  .env.example  README.md
config/scaffold.json                                      records the chosen language and plugin version
```

- Existing files are skipped; they are overwritten only with `--update` (plugin-owned files) or `--force` (all).
- `.gitignore` lines and `package.json` scripts are merged, never replaced. No dependencies are added.
- The project's root `CLAUDE.md` gets the pipeline's hard rules between `<!-- automation-builder:start/end -->` markers.

Optional: `--with-demo` adds the local demo app (`npm run demo:app`) and demo test cases under `automation/demo/`;
`--with-pipeline-tests` adds the pipeline's own `node:test` suites (`npm run test:pipeline`).
