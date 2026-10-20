# Test automation ({{LANGUAGE}} · Playwright Test)

This folder is a self-contained Playwright project scaffolded by the `automation-builder` plugin. It has its own
`package.json` and `node_modules`; nothing outside `automation/` is modified. Run every command below from
this folder (`cd automation`).

Language: **{{LANGUAGE}}** (chosen at `/automation-builder:init`; fixed for this folder).

## Layout

```
playwright.config.{{EXT}}   thin wrapper: every value comes from config/automation.config.json (+ PW_* env overrides)
fixtures/test.{{EXT}}       the shared `test` / `expect` — import these, never @playwright/test directly
pages/                  page objects (BasePage.{{EXT}} + one class per page/component)
utils/test-data.{{EXT}}     requireEnv(), uniqueSuffix(), redact()
tests/
  generated/            written by the pipeline only (*.spec.{{EXT}}); regenerated and healed by it
  handwritten/          yours; the pipeline never modifies it
  setup/                *.setup.{{EXT}} — one-time login when auth is "storage-state"
config/                 automation.config.json (approved, non-secret choices), dependency-log.json, scaffold.json
input/test-cases/       your Markdown / CSV test cases
output/runs/<run-id>/   per-run manifest, evidence, reports (git-ignored)
engine/                 the pipeline engine (TypeScript run by Node 24+). Plugin-managed: refresh it with
                        /automation-builder:init --update instead of editing it
docs/                   test-case format and run-artifact reference
.env.example            names of the environment variables the tests read — copy to .env (git-ignored)
```

## Daily use

| Task | Command |
|---|---|
| Run the whole pipeline (from the project root) | `/automation-builder:playwright-pipeline automation/input/test-cases` |
| Run the tests directly | `npm test` (Playwright, all projects) · `npm run test:headed` · `npm run test:ui` |
| Open the last HTML report | `npm run report` |
| Pipeline CLI | `npm run pipeline -- run list` |

## Writing tests by hand

Put them in `tests/handwritten/<feature>.spec.{{EXT}}`:

```{{FENCE}}
{{EXAMPLE}}
```

Conventions (the pipeline's reviewer enforces the same ones for generated tests):

- Import `test` and `expect` from `fixtures/test.{{EXT}}`; it adds failure diagnostics automatically.
- Start the title with `[<ID>] ` and add the `testId` annotation — results, triage and healing map back to it.
- Locators in this order: `getByRole` → `getByLabel` → `getByPlaceholder` / `getByText` → `getByTestId` →
  a scoped `locator()` with a comment. No XPath, no `waitForTimeout`, no `.only` / `.skip`.
- Page objects own locators and actions; assertions stay in the test.
- Navigate with relative paths (`page.goto('/login')`); the base URL comes from config.
- Secrets: `requireEnv('NAME')` only. Real values live in `.env`, never in code, config or reports.
- Create data with `uniqueSuffix()` and clean up only what the test created.

## Configuration

Settings are chosen once with `/automation-builder:playwright-pipeline` and stored in
`config/automation.config.json` (never edit it by hand). Precedence, low → high: built-in defaults →
config file → env vars (`PW_BASE_URL`, `PW_ENVIRONMENT`, `PW_BROWSERS`, `PW_WORKERS`, `PW_RETRIES`) → command arguments.
