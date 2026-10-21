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
| 4 | test_analysis | Normalizes the cases into `canonical-test-cases.json` and projects `test-specs.json` from it (cached while the input is unchanged). Ambiguous cases are flagged and become questions for you; steps and expected results are never invented. An agent is used only when something needs judgment. |
| 5 | application_exploration | Opens the real app (Playwright CLI or the aria-snapshot fallback), records the pages and durable locators, and saves evidence. |
| 6 | test_generation | Writes Playwright tests in `automation/tests/` (each file marked `// @automation-builder:generated`; plus page objects in `automation/pages/` where they remove duplication) from the specs and the observed UI, using shared fixtures. Unchanged tests from an earlier run are reused; the rest are generated in parallel, one module file per generator. |
| 7 | script_review | Static review plus typecheck: assertions match the specs, locators are reliable, and no secrets, sleeps or skips. |
| 8 | execution | Runs the tests and normalizes the results. Collects screenshots, video and traces. |
| 9 | failure_triage | Classifies each failure: script defect, application defect, environment, test data or flaky. |
| 10 | healing | Repairs **only** confirmed script defects, at most 2 attempts per test. A guard rejects any patch that weakens assertions. Patches that don't fix the test are reverted. |
| 11 | regression_validation | Re-runs the healed tests with retries off. |
| 12 | report_generation | Generates HTML / JSON / JUnit / Allure reports (whichever you chose) and `summary.md`. Report mode (`standard`, `full`, `audit`) decides how much is produced; **audit** can add the custom evidence report: one PDF with every executed step next to the screenshot taken when it ended (see below). `reportGeneration` (did the reporters work) is reported apart from the test counts. |
| 13 | finalization | Sets the final outcomes: `passed`, `failed`, `flaky`, `healed`, `blocked`, `skipped`. |

Each run's state lives on disk in `dependencies/runs/<run-id>/`, so a stopped or blocked run can be resumed. Application
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

**Upgrading from 0.2.x:** 0.2.x kept the pipeline engine, docs, input and run output inside `automation/`. 0.4.0 keeps
`automation/` to the Playwright framework and moves the rest to a sibling `dependencies/` folder. Run
`/automation-builder:init` in the project: it detects the old layout, shows what it would move (dry run), and after your
confirmation migrates it (see below). It also flattens `tests/generated/` and `tests/handwritten/` into a single `tests/`
folder (pipeline-written files get a `// @automation-builder:generated` header; yours stay untouched). Old runs are kept in
`dependencies/runs/` as history only.

**Upgrading from 0.1.x:** earlier versions scaffolded at the project root (`src/`, `tests/`, `config/`). 0.2.0+ scaffolds into
`automation/` and `dependencies/` and asks for the language. `/automation-builder:init` leaves the old root files untouched and warns; move
`config/automation.config.json` (its `language` must match the one you pick at init) and your tests (`tests/`) into
`automation/`, and `input/` into `dependencies/`, by hand if you want to keep them, then delete the old `src/`.

## Use it

### 1. Scaffold the framework into your project (one time)

Open Claude Code in the project you want to test and run:

```
/automation-builder:init
```

Claude first **asks whether you want TypeScript or JavaScript**. The choice decides the language of the fixtures,
page objects, `playwright.config` and every generated test; it is recorded in `dependencies/state/scaffold.json` and
fixed for the project. (Pass `--language typescript|javascript` to skip the question.)

Two sibling folders are scaffolded. **`automation/`** is the Playwright framework and nothing else (own `package.json`),
following the structure in `playwright_framework_structure.md`; **`dependencies/`** holds everything the pipeline needs
that is not framework:

```
automation/                       the framework only
  pages/BasePage.*                page objects (mandatory folder)
  tests/                          all tests; files marked "@automation-builder:generated" are pipeline-owned, the rest are yours
  helpers/test-data.*             requireEnv(), requireWorkerEnv(), uniqueSuffix(), redact() (mandatory folder)
  fixtures/test.*                 shared test/expect with automatic failure diagnostics
  config/                         approved settings (automation.config.json)
  reports/  test-results/         generated per run: <run-id>/<label>/ (reports; screenshots, video, traces)
  auth/  test-data/               created only when a test needs them (storage-state login; non-sensitive data)
  playwright.config.{ts,js}       standard Playwright config, filled from config/automation.config.json; yours to edit
  package.json  .gitignore  .env.example  README.md  tsconfig.json | jsconfig.json
dependencies/                     not framework
  engine/  docs/                  the pipeline engine and reference (plugin-managed)
  input/test-cases/               your test cases, converted to Markdown (one file per module)
  runs/                           per-run state (git-ignored)
  state/                          scaffold.json (language), dependency-log.json
  package.json  tsconfig.json     [demo/  engine-tests/ with the optional flags]
```

The only project-root change is a rules block in `CLAUDE.md`. Init shows a dry run first, never overwrites existing
files, and **installs nothing**. Optional flags: `--with-demo` (local demo app), `--with-pipeline-tests`, `--update`,
`--force`.

### 2. Point the pipeline at your test cases

Keep them wherever you like: Markdown (`.md`), CSV (`.csv`) or Excel (`.xlsx`), **in whatever column layout you already use**.
`/automation-builder:playwright-pipeline` asks where they are, converts them to the pipeline's own Markdown format (one file per
test case, named after its ID, so a single case is easy to find and edit) and saves them in `dependencies/input/test-cases/`; your original is only read, never changed. Credentials in them go to
`automation/.env`. You can also run it yourself: `node dependencies/engine/cli/pipeline.ts input import --from <file-or-folder>`
(re-running is harmless; a changed file is only replaced with `--overwrite`). Each case needs an ID or a title, steps, and an expected result. Column names are matched flexibly (`TC No`,
`Scenario`, `Procedure`, `Expected Outcome` …), a title block above the table is skipped, and one sheet per module works. If a layout
isn't recognised, Claude asks which of your headers is which and remembers the answer (`input inspect` / `input map`); you never
have to reformat the file. Columns that match nothing (Status, Actual Result, …) are listed, never silently dropped. The same cases are written
back in the pipeline's own format to `runs/<run-id>/normalized-input/`.

Every format is normalized once into `canonical-test-cases.json` (each case with its source row or line and a status: `valid`,
`warning`, `needs_clarification` or `invalid`); `test-specs.json` is projected from it, and nothing downstream reads your original
files. Two details about layouts: when two columns fit a field equally well (`Steps` and `Test Steps`), the cases of that table wait
until you say which one (`input map`); when no header names the steps, expected result or ID, the columns' content is read and the
reading is used only at 90% confidence or better, reported as a warning you can confirm. Known limits: step-level test data is kept
only in the canonical document (a case imported as Markdown keeps its case-level data), and in a Markdown case an unindented plain-text
line inside Steps or Expected Results can be read as metadata. Examples are in `dependencies/docs/examples/`:

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

You don't have to set that up by hand. Credentials, usernames and emails written in your test cases (a `password:` or
`email:` line under Test Data, or an email address typed in a step) are moved into `automation/.env` by the pipeline as
`TEST_<NAME>` variables; the specs and generated tests only reference the names (`requireEnv('TEST_PASSWORD')`). The
pipeline asks you for nothing it can already see: when a value is genuinely missing (for example you wrote
`env:TEST_ADMIN_EMAIL` and nothing sets it), it lists the names to fill in `automation/.env` and waits. A value already in
your `.env` is never overwritten. Write `literal:<value>` for a deliberately fake value (a wrong password) to keep it out of `.env`.

**Modules.** Test cases belong to modules (Login, Create Project, …): a Markdown `# heading`, an Excel sheet name, or a
`Module` / `Feature` column, with the file name as the fallback. Tests are generated module by module: `automation/tests/login.spec.ts`,
`automation/tests/create-project.spec.ts`, … , one file per module and never several modules in one file. A module's file is
never written over a handwritten test of the same name (the module then gets `<module>.generated.spec.ts`).

### 3. Run the pipeline

```
/automation-builder:playwright-pipeline                       # asks where your test cases are
/automation-builder:playwright-pipeline D:\QA\cases.xlsx      # or give the path up front
```

On the first run, Claude asks for the missing settings and asks for approval before each install
(`typescript` for TypeScript projects, `@playwright/test`, browsers, `@playwright/cli`, Allure). Everything installs into `automation/`. Your answers are saved and reused on later
runs. If you decline something the run stops as `blocked` and tells you how to resume.

### Commands

| Command | Does |
|---|---|
| `/automation-builder:init [--language typescript|javascript] [--update] [--with-demo] [--with-pipeline-tests] [--force]` | Ask TypeScript or JavaScript, then scaffold, update or migrate `automation/` (framework) and `dependencies/` (pipeline). |
| `/automation-builder:playwright-pipeline [path]` | Run the full 13-stage pipeline. |
| `/automation-builder:generate-tests [path]` | Parse → explore → generate → review (no execution). |
| `/automation-builder:run-tests [files...]` | Execute existing tests → triage → report (no edits). |
| `/automation-builder:heal-tests <run-id>` | Repair eligible script defects from an earlier run → regression check → report. |

Each command also accepts `resume [<run-id>]` to continue a stopped run from its on-disk checkpoint (see below).

### Resuming a run (you don't need the run ID)

Run state is on disk, so a run survives a closed terminal, a crash, a declined install or a blocked stage. To pick it up,
open Claude Code in the project and run the same command you started with, followed by `resume` and **no id**:

```
/automation-builder:playwright-pipeline resume
/automation-builder:generate-tests resume
/automation-builder:run-tests resume
/automation-builder:heal-tests resume
```

Without an id the pipeline picks the **newest unfinished run of that command**: one whose status is `in_progress`, `blocked`
or `failed`. Runs that are `completed` or `cancelled` are never resumed. Before doing anything it shows you where the run
stopped: the run id, the stages already completed, the stage it resumes at, and why it stopped. Completed stages are never
repeated; a stage that was still `running` when the process died is treated as interrupted and re-run from scratch.

- **Several unfinished runs?** It resumes the newest and tells you how many others exist. To pick another, list them and pass its id.
- **Nothing to resume?** It says so and offers to start a new run.
- **Resume is per command.** `/automation-builder:run-tests resume` only looks at runs started by `run-tests`.

To look for run ids yourself (the newest is listed first; ids start with the UTC start time):

```bash
node dependencies/engine/cli/pipeline.ts run resumable                            # unfinished runs, with the stage each resumes at and why it stopped
node dependencies/engine/cli/pipeline.ts run resumable --command run-tests        # only runs of one command
node dependencies/engine/cli/pipeline.ts run list                                 # every run, finished or not
ls dependencies/runs/                                                             # the folder names are the run ids
```

Then `/automation-builder:playwright-pipeline resume <run-id>`. Resuming restores the pipeline run, not the chat: it does not need
the earlier Claude Code conversation, because everything it needs is in `dependencies/runs/<run-id>/manifest.json`.

### Results

```
dependencies/runs/<run-id>/              pipeline state
  manifest.json            stages, statuses, config snapshot, input hashes, setup changes
  canonical-test-cases.json  every test case in one schema, with its validation status
  test-specs.json          projected from the canonical cases; what later stages read
  exploration/             observed pages, locators, snapshots
  execution-results.json   normalized results
  failure-analysis.json    category + confidence + evidence per failure
  healing/                 before-snapshots, diffs, guard results, rerun outcomes
  summary.md               final counts, unresolved failures, links to the HTML/JUnit/Allure reports
automation/reports/<run-id>/<label>/     HTML / JSON / JUnit / Allure reporter output
automation/reports/<run-id>/evidence-report/  evidence-report.pdf (+ the self-contained .html it is printed from), if chosen
automation/test-results/<run-id>/<label>/  screenshots, videos, traces
```

### Try the demo

```
/automation-builder:init --with-demo
```

Then run `npm run demo:app` from `dependencies/` (serves on `http://localhost:4173`) and `/automation-builder:playwright-pipeline
dependencies/demo/test-cases`, using base URL `http://localhost:4173` and environment `demo`. DEMO-1 and DEMO-2 pass. DEMO-3
fails as an **application defect** (the cart total bug is deliberate), and the pipeline reports it without healing it.

## Doing less work, safely

Runs reuse what is provably unchanged (normalized specs, generated tests, review results, the typecheck, saved exploration observations),
ask an agent only where judgment is needed, validate saved login state before trusting it, and keep parallel work from colliding.
`cache status <run-id>` shows what was reused and why anything was rebuilt; `agents plan` shows which stages needed an agent;
`run compare <baseline> <run>` checks that no test went missing or got worse before it believes a speed-up. The mechanics, trade-offs and
limits are in `dependencies/docs/pipeline-efficiency.md` after `init`, and in `plugins/automation-builder/template/dependencies/docs/`.

## Nothing is left running

A run starts browsers (the explorer's `playwright-cli` session, the test runner's workers) and can start a web server. The pipeline stops them
itself: the runner and the report tools run under a supervisor that stops the whole process tree on a timeout and anything left behind when the
command ends, and `cleanup run <run-id>` closes the run's browser session (`explore-<run-id>`) and stops what remains. It runs automatically when
exploration ends, when any stage fails, blocks or is cancelled, on `resume`, and in `run finalize`, whose `cleanup` block reports what was
stopped and anything that could not be (`stillRunning`). Only processes recorded for the run, or sessions named with its run id, are touched;
your own browsers and servers never are. `cleanup run <run-id> --dry-run` previews it, and `cleanup all [--dry-run]` clears leftovers of earlier
crashed runs. Details and limits: `dependencies/docs/pipeline-efficiency.md`, section 7.

## Custom evidence report (`evidence-pdf`)

For QA sign-off you often need proof of *what was executed*, not just a pass/fail count. Choose **audit** report mode during setup and
opt in to step evidence and the **evidence-pdf** reporter (both off by default), and the run ends with
`automation/reports/<run-id>/evidence-report/evidence-report.pdf`:

- a cover page with the run, environment, counts, a clickable list of tests, and any **evidence gaps**;
- per test: the module, preconditions, the steps of the test case, a compact table of the **executed steps** (result,
  duration, the error of a failed step), **one video of the complete execution journey embedded in the PDF**, and
  **one screenshot of the final state** (after the last assertion, or at the failure);
- retries and the regression re-run appear as their own attempts (each with its own video), so a flaky test shows the failing attempt too;
- the test case's expected results, with the test's overall result.

How it is made: Playwright records one video per test (`evidence.video` must be `"on"`; the evidence-pdf reporter requires it). The
shared `fixtures/test.*` records each `test.step` and the final-state screenshot (only when this reporter is chosen); `report build`
lays them out as one self-contained HTML file and prints it with the project's own Playwright + Chromium, so there is **no extra
package**. Chromium cannot embed media, so each video's play-icon link is then replaced, in an appended PDF update
(`engine/pipeline/pdf-embed.ts`, no library), by a file-attachment annotation holding the recording, and the videos are listed in the
PDF's Attachments panel. The PDF is read back and every video is checked byte for byte; if that fails the reporter fails rather than
shipping a PDF without its videos. Chromium must be installed (preflight asks to approve it if you only run Firefox/WebKit).
Cost: a video per test for every test (WebM, typically tens to a few hundred KB), passing ones included, and one screenshot per attempt.

**Viewer support and fallback.** The videos are *embedded files*, not in-page players: Playwright records WebM and PDF in-page
playback (RichMedia/Screen annotations) needs H.264 MP4, which would need a transcoder such as ffmpeg (a new dependency, not added).
Adobe Acrobat/Reader, Foxit and PDF-XChange open the attachment from the icon or Attachments panel; browser viewers may not show
attachments at all. Fallback: the cover page explains this, and each video's section prints the path of the same recording under
`automation/test-results/<run-id>/`.

Password fields (and `reporting.maskSelectors`) are masked in the screenshots; other visible page data is not, and the videos are not masked at all.

Existing project? Run `/automation-builder:init --update`: an unmodified `fixtures/test.*` is refreshed; a customised one
is left alone and you get the exact snippet to copy.

## Repository layout

```
.claude-plugin/marketplace.json        marketplace catalog
plugins/automation-builder/
  .claude-plugin/plugin.json           plugin manifest
  skills/                              commands (/automation-builder:<name>) + knowledge skills
  agents/                              six stage subagents
  scripts/init.mjs                     project scaffolder used by /automation-builder:init
  template/                            files copied into the user's project: dependencies/ (engine/, docs/, demo/, engine-tests/)
                                       and framework/{common,typescript,javascript}/ (copied into automation/)
```

See [plugins/automation-builder/README.md](plugins/automation-builder/README.md) for plugin internals.

## Releasing a new version

Run the scaffolder's layout tests (`node --test plugins/automation-builder/tests/init.test.mjs`: `automation/` stays framework-only,
legacy layouts migrate), and the pipeline's own suites from a scaffolded project (`cd dependencies && npm run validate`,
scaffold with `--with-pipeline-tests`). Then bump `version` in both `plugins/automation-builder/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`,
validate with `claude plugin validate .`, then push.
