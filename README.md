# Automation Builder: agentic Playwright pipeline for Claude Code

This repository is a Claude Code **plugin marketplace** containing one plugin, `automation-builder`. You write test
cases in plain Markdown or CSV and run one command. Claude turns them into reviewed, executed Playwright tests,
repairs broken test scripts within strict limits, and writes an auditable report. Nothing is installed without
your explicit approval.

## What it does

`/automation-builder:playwright-pipeline` runs 13 gated stages. Each stage must finish, with its required
artifacts, before the next one starts:

| # | Stage | What happens |
|---|---|---|
| 1 | preflight | Read-only check of Node, npm, Playwright, browsers and config. Nothing is changed. |
| 2 | configuration | Asks only for missing settings (base URL, environment, test-case path, browsers, evidence, reporters, auth) and saves them to `automation/config/automation.config.json`. Each missing dependency is offered separately, with the exact command. |
| 3 | input_validation | Checks the test-case files: format, IDs, steps, expected results, and no literal credentials. |
| 4 | test_analysis | Normalizes the cases into `test-specs.json`. Ambiguous cases are flagged and become questions for you; steps and expected results are never invented. |
| 5 | application_exploration | Opens the real app (Playwright CLI or the aria-snapshot fallback), records the pages and durable locators, and saves evidence. |
| 6 | test_generation | Writes Playwright tests in `automation/tests/generated/` (plus page objects in `automation/pages/` where they remove duplication) from the specs and the observed UI, using shared fixtures. |
| 7 | script_review | Static review plus typecheck: assertions match the specs, locators are reliable, and no secrets, sleeps or skips. |
| 8 | execution | Runs the tests and normalizes the results. Collects screenshots, video and traces. |
| 9 | failure_triage | Classifies each failure: script defect, application defect, environment, test data or flaky. |
| 10 | healing | Repairs **only** confirmed script defects, at most 2 attempts per test. A guard rejects any patch that weakens assertions. Patches that don't fix the test are reverted. |
| 11 | regression_validation | Re-runs the healed tests with retries off. |
| 12 | report_generation | Generates HTML / JSON / JUnit / Allure reports (whichever you chose) and `summary.md`. |
| 13 | finalization | Sets the final outcomes: `passed`, `failed`, `flaky`, `healed`, `blocked`, `skipped`. |

Each run's state lives on disk in `automation/output/runs/<run-id>/`, so a stopped or blocked run can be resumed. Application
bugs are reported, never "fixed". A test that passes only on retry is reported as `flaky`, not `passed`.

## Install the plugin

Requirements: Claude Code and **Node 24+** (the engine runs TypeScript directly; your tests can be TypeScript or JavaScript).

In Claude Code:

```
/plugin marketplace add akhilvn-crypto/automation-builder
/plugin install automation-builder@automation-builder-marketplace
```

Or from a shell:

```bash
claude plugin marketplace add akhilvn-crypto/automation-builder
claude plugin install automation-builder@automation-builder-marketplace
```

Restart Claude Code (or run `/reload-plugins`) if the commands don't appear.

**Team setup:** add this to a project's `.claude/settings.json` so everyone who opens the project is offered the
plugin:

```json
{
  "extraKnownMarketplaces": {
    "automation-builder-marketplace": {
      "source": { "source": "github", "repo": "akhilvn-crypto/automation-builder" }
    }
  },
  "enabledPlugins": { "automation-builder@automation-builder-marketplace": true }
}
```

**Update:** `/plugin marketplace update automation-builder-marketplace`, then run `/automation-builder:init --update`
in each project to refresh the engine files.

**Upgrading from 0.1.x:** earlier versions scaffolded at the project root (`src/`, `tests/`, `config/`). 0.2.0 scaffolds into
`automation/` and asks for the language. `/automation-builder:init` leaves the old root files untouched and warns; move
`config/automation.config.json` (its `language` must match the one you pick at init), `input/` and `tests/handwritten/` into
`automation/` by hand if you want to keep them, then delete the old `src/`.

## Use it

### 1. Scaffold the framework into your project (one time)

Open Claude Code in the project you want to test and run:

```
/automation-builder:init
```

Claude first **asks whether you want TypeScript or JavaScript**. The choice decides the language of the fixtures,
page objects, `playwright.config` and every generated test; it is recorded in `automation/config/scaffold.json` and
fixed for that folder. (Pass `--language typescript|javascript` to skip the question.)

Everything is then scaffolded into a self-contained **`automation/`** folder with its own `package.json`:

```
automation/
  playwright.config.{ts,js}     config wrapper (values come from config/automation.config.json)
  fixtures/test.*               shared test/expect with automatic failure diagnostics
  pages/BasePage.*              base class for page objects
  utils/test-data.*             requireEnv(), uniqueSuffix(), redact()
  tests/generated/              written by the pipeline        tests/handwritten/   yours, never touched
  tests/setup/                  one-time login for storage-state auth
  input/test-cases/             your Markdown / CSV test cases
  config/  output/runs/         approved settings, per-run evidence and reports
  engine/                       the pipeline engine (plugin-managed)
  package.json  .gitignore  .env.example  README.md  tsconfig.json | jsconfig.json
```

The only project-root change is a rules block in `CLAUDE.md`. Init shows a dry run first, never overwrites existing
files, and **installs nothing**. Optional flags: `--with-demo` (local demo app), `--with-pipeline-tests`, `--update`,
`--force`.

### 2. Write test cases

Put Markdown (`.md`) or CSV (`.csv`, e.g. exported from Excel) files in `automation/input/test-cases/`. Each case needs an ID
or a title, steps, and an expected result. Examples are in `docs/examples/`:

```markdown
## TC-001: Valid user can sign in
Tags: smoke, auth

### Test Data
- email: env:TEST_USER_EMAIL
- password: env:TEST_USER_PASSWORD

### Steps
1. Open the login page
2. Enter {email} in the Email field
3. Enter {password} in the Password field
4. Click the "Sign in" button

### Expected Results
- The heading "Dashboard" is visible
- The URL contains "/dashboard"
```

Secrets go in `automation/.env` (git-ignored; copy `automation/.env.example`). Test cases and config refer to env var **names** only.

### 3. Run the pipeline

```
/automation-builder:playwright-pipeline automation/input/test-cases/login.md
```

On the first run, Claude asks for the missing settings and asks for approval before each install
(`typescript` for TypeScript projects, `@playwright/test`, browsers, `@playwright/cli`, Allure). Everything installs into `automation/`. Your answers are saved and reused on later
runs. If you decline something the run stops as `blocked` and tells you how to resume.

### Commands

| Command | Does |
|---|---|
| `/automation-builder:init [--language typescript|javascript] [--update] [--with-demo] [--with-pipeline-tests] [--force]` | Ask TypeScript or JavaScript, then scaffold or update the framework in `automation/`. |
| `/automation-builder:playwright-pipeline [path]` | Run the full 13-stage pipeline. |
| `/automation-builder:generate-tests [path]` | Parse → explore → generate → review (no execution). |
| `/automation-builder:run-tests [files...]` | Execute existing tests → triage → report (no edits). |
| `/automation-builder:heal-tests <run-id>` | Repair eligible script defects from an earlier run → regression check → report. |

Each command also accepts `resume <run-id>` to continue a stopped run.

### Results

```
automation/output/runs/<run-id>/
  manifest.json            stages, statuses, config snapshot, input hashes, setup changes
  test-specs.json          normalized test cases
  exploration/             observed pages, locators, snapshots
  execution-results.json   normalized results
  failure-analysis.json    category + confidence + evidence per failure
  healing/                 before-snapshots, diffs, guard results, rerun outcomes
  reports/summary.md       final counts, unresolved failures, links to the HTML/JUnit/Allure reports
  evidence/                screenshots, videos, traces
```

### Try the demo

```
/automation-builder:init --with-demo
```

Then run `npm run demo:app` (serves on `http://localhost:4173`) and `/automation-builder:playwright-pipeline
automation/demo/test-cases`, using base URL `http://localhost:4173` and environment `demo`. DEMO-1 and DEMO-2 pass. DEMO-3
fails as an **application defect** (the cart total bug is deliberate), and the pipeline reports it without healing it.

## Repository layout

```
.claude-plugin/marketplace.json        marketplace catalog
plugins/automation-builder/
  .claude-plugin/plugin.json           plugin manifest
  skills/                              commands (/automation-builder:<name>) + knowledge skills
  agents/                              six stage subagents
  scripts/init.mjs                     project scaffolder used by /automation-builder:init
  template/                            files copied into the user's automation/ folder (engine/, framework/{common,typescript,javascript}/, docs, demo)
```

See [plugins/automation-builder/README.md](plugins/automation-builder/README.md) for plugin internals.

## Releasing a new version

Bump `version` in both `plugins/automation-builder/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`,
validate with `claude plugin validate .`, then push.
