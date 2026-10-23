# Automation Builder

A [Claude Code](https://claude.com/claude-code) plugin that turns your manual test cases into reviewed, executed
Playwright tests. You write the cases in Markdown, CSV or Excel and run one command. The plugin explores your app, generates
the tests, runs them, repairs broken *scripts* within strict limits, and produces the reports you chose.

Nothing is installed without your explicit yes, and secrets never leave `.env`.

## What the pipeline does

`/automation-builder:playwright-pipeline` runs 13 gated stages. A stage starts only when the one before it is complete.

| Phase | Stages | What happens |
|---|---|---|
| **Set up** | preflight, configuration | Read-only check of Node, Playwright and browsers. Asks only for what is missing (base URL, browsers, reporters, login) and saves your answers. |
| **Understand** | input_validation, test_analysis | Validates your test cases and normalizes them. Ambiguities become questions for you; steps and expected results are never invented. |
| **Build** | application_exploration, test_generation, script_review | Opens the real app to record durable locators, writes one Playwright test file per module, then reviews it (assertions match the spec, no secrets, sleeps or skips). |
| **Run** | execution, failure_triage | Runs the tests with screenshots, video and traces, then classifies each failure: script defect, application defect, environment, test data or flaky. |
| **Repair** | healing, regression_validation | Fixes **only** confirmed script defects, at most 2 attempts per test. A guard rejects any patch that weakens an assertion; patches that don't help are reverted. Healed tests are re-run. |
| **Report** | report_generation, finalization | Builds the reports you selected and a `summary.md`. Final outcomes: `passed`, `failed`, `flaky`, `healed`, `blocked`, `skipped`. |

Ground rules: application bugs are reported, never "fixed"; a test that only passes on retry is `flaky`, not `passed`;
tests are never skipped or weakened to get a green run.

## Quick start

**Requirements:** Claude Code and a Node.js that can run `.ts` files natively (no version is enforced; Node 22.18+ does this out of the box).

**1. Install the plugin** (in Claude Code):

```
/plugin marketplace add akhilvn-crypto/automation-builder
/plugin install automation-builder@automation-builder-marketplace
```

Restart Claude Code or run `/reload-plugins` if the commands don't appear.

**2. Scaffold your project** (once). Open Claude Code in the project you want to test and run:

```
/automation-builder:init
```

Claude asks whether you want **TypeScript or JavaScript** (fixed for the project afterwards) and creates two folders.
It never overwrites existing files and installs nothing.

```
automation/       the Playwright framework: pages/, tests/, helpers/, fixtures/, config/, playwright.config, .env.example
dependencies/     everything the pipeline needs: engine/, docs/, input/test-cases/, runs/, state/
```

**Or do steps 2 and 3 in one go:** `/automation-builder:do-automation` asks the language, scaffolds the project and runs
every pipeline stage, stopping only for your choices and install approvals (see Commands).

**3. Run the pipeline:**

```
/automation-builder:playwright-pipeline                    # asks where your test cases are
/automation-builder:playwright-pipeline D:\QA\cases.xlsx   # or pass the path
```

On the first run Claude asks for the missing settings, and for approval before each install (`@playwright/test`,
browsers, `@playwright/cli`, Allure if chosen, `typescript` for TypeScript projects). Installs go into `automation/` and your
answers are saved for later runs. If you decline something, the run stops as `blocked` and tells you how to resume.

**4. Read the results** in `automation/reports/<run-id>/` and `dependencies/runs/<run-id>/summary.md`.

Want to see it work first? Run `/automation-builder:init --with-demo`, start the demo app with `npm run demo:app` (in
`dependencies/`), then run the pipeline on `dependencies/demo/test-cases` with base URL `http://localhost:4173`. DEMO-1 and
DEMO-2 pass; DEMO-3 fails as an *application defect* by design, and the pipeline reports it without touching it.

## Writing your test cases

Use Markdown, CSV or Excel (`.xlsx`) **in the column layout you already have**. Headers such as `TC No`, `Scenario`,
`Procedure` or `Expected Outcome` are matched flexibly, and if a layout isn't recognised Claude asks which column is which.
Your original file is only read, never changed; the pipeline converts the cases into its own Markdown (one file per case) in
`dependencies/input/test-cases/`. Each case needs an ID or title, steps and an expected result.

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

### Test case template

Copy this for a new case. Only the ID or title, the steps and the expected results are required; delete the rest if you don't need it.

```markdown
# Login                                  <- optional: the module (several `#` headings in one file = several modules)

## TC-001: Valid user can sign in        <- ID is optional; without one a stable AUTO-xxxxxxxx ID is derived
Priority: High                           <- optional
Tags: smoke, auth                        <- optional, comma-separated
Depends on: TC-000                       <- optional: test IDs that must run first (they then run in order, in one serial group)

### Preconditions
- An active test account exists

### Test Data
- email: env:TEST_USER_EMAIL             <- env var NAME; the value lives in automation/.env
- password: env:TEST_USER_PASSWORD
- plan: Premium                          <- plain literal
- wrong_password: literal:wrong-pass-1   <- explicitly fake value, kept out of .env

### Steps
1. Open the login page
2. Enter {email} in the Email field      <- {name} must be defined in Test Data
3. Enter {password} in the Password field
4. Click the "Sign in" button -> Expected: The dashboard is displayed   <- optional inline expectation for a step

### Expected Results
- The heading "Dashboard" is visible
- The URL contains "/dashboard"
```

Using Excel or CSV instead? One row per case, with these columns. The names are matched flexibly, so keep your own.

| Column | Required | Also recognised as | Notes |
|---|---|---|---|
| Test Case ID | ID or title | `TC ID`, `Test Case No`, `Ref` | Must be unique; duplicates are flagged |
| Title | ID or title | `Scenario`, `Test Case Name`, `Summary` | |
| Module | no | `Feature`, `Functionality`, `Area`, `Component` | The sheet name is used without it |
| Preconditions | no | `Prerequisites`, `Precondition` | |
| Steps | **yes** | `Test Steps`, `Procedure`, `Action` | One step per line, numbered or not |
| Test Data | no | | `env:VAR`, `literal:value` or a plain value |
| Expected Result | **yes** | any header starting `Expected` | One result per line |
| Priority | no | | |
| Tags | no | `Tag`, `Labels`, `Keywords` | Comma-separated |
| Depends on | no | `Dependency`, `Dependencies`, `Prerequisite Test(s)`, `Blocked By` | Test IDs; separate several with comma, semicolon, "and" or new lines |

```csv
Test Case ID,Module,Title,Preconditions,Steps,Test Data,Expected Result,Priority,Tags,Depends on
TC-001,Login,Valid user can sign in,An active test account exists,"1. Open the login page
2. Enter {email} in the Email field
3. Enter {password} in the Password field
4. Click the ""Sign in"" button","email: env:TEST_USER_EMAIL
password: env:TEST_USER_PASSWORD","The heading ""Dashboard"" is visible
The URL contains ""/dashboard""",High,"smoke, auth",
TC-002,Login,Signed-in user can sign out,,"1. Click ""Sign out""",,The login page is shown,Medium,auth,TC-001
```

A case that is missing steps or expected results, uses an undefined `{name}`, or depends on an unknown ID is not generated until you
answer the question Claude asks about it. Any other layout is fine too: if it isn't recognised, Claude asks which column is which.

**Modules.** Cases are grouped into modules (a Markdown `# heading`, an Excel sheet name, or a `Module` column) and
generated as one file per module: `automation/tests/login.spec.ts`, `create-project.spec.ts`, and so on.

**Credentials.** Never put real secrets in config or tests. Credentials and emails found in your test cases are moved into
`automation/.env` as `TEST_<NAME>` variables automatically, and tests only reference the names. You only need to edit
`.env` when the pipeline lists a value it could not find. Write `literal:<value>` to keep a deliberately fake value (such as a
wrong password) out of `.env`.

## Commands

| Command | Does |
|---|---|
| `/automation-builder:do-automation [path] [--language typescript|javascript] [--with-demo]` | Guided end to end: asks the language, scaffolds, then runs all 13 stages. Stops only for your choices, one-by-one install approvals, missing `.env` values and blockers. `resume [<run-id>]` continues. Works in Claude Code and Claude Cowork. |
| `/automation-builder:init [--language typescript\|javascript] [--update] [--with-demo] [--force]` | Scaffold, update or migrate `automation/` and `dependencies/`. |
| `/automation-builder:playwright-pipeline [path]` | The full 13-stage pipeline. |
| `/automation-builder:generate-tests [path]` | Parse, explore, generate and review. Does not execute. |
| `/automation-builder:run-tests [files...]` | Execute existing tests, triage failures, report. Edits nothing. |
| `/automation-builder:heal-tests <run-id>` | Repair eligible script defects from an earlier run, re-validate, report. |
| `/automation-builder:reports [show]` | Change which reports are produced (Playwright default report, Allure, Extent, Evidence PDF) at any time: shows what is on, lets you turn reports off or add new ones, saves it. Applies from the next run; runs no tests. |

**Claude Code and Claude Cowork.** Choices are shown as a dialog (`AskUserQuestion`). Where that dialog does not appear, as can
happen in Cowork, Claude asks the same question as a numbered list in chat and waits for your reply; it never picks for you.
Installs are still approved one dependency at a time. Cowork needs a Node in its sandbox that runs `.ts` files natively, runs tests headless, and can only reach apps
the sandbox can reach. Details: `skills/playwright-pipeline/environment.md`.

**Resuming.** Run state is saved on disk, so a closed terminal, crash or declined install doesn't lose the run. Repeat the
command you started with, followed by `resume` (no run id needed): `/automation-builder:playwright-pipeline resume`. It
continues the newest unfinished run of that command, skips completed stages, and re-runs any stage that was interrupted.
`node dependencies/engine/cli/pipeline.ts run resumable` lists the candidates.

**Day-to-day, outside Claude** (from `automation/`): `npm test` runs the tests as a recorded run with reports and evidence;
`npm run test:adhoc` is plain Playwright with nothing recorded, for debugging.

## Reports

Setup asks which reports you want. Only the ones you pick are built (JSON results are always kept):

- **Playwright default report**: the standard HTML report.
- **Allure report**: needs `allure-playwright` and the Allure CLI (offered for approval).
- **Extent report**: one self-contained HTML dashboard with charts, a searchable test list, steps, errors and screenshots. Built by the
  pipeline itself, with no package.
- **Evidence PDF**: for sign-off. One PDF with every executed step, a final-state screenshot and an embedded video per test.
  Needs Chromium; videos open in Acrobat/Reader, Foxit or PDF-XChange (browser viewers may not show attachments). Password
  fields are masked in screenshots; videos are not masked.

Outputs: reports in `automation/reports/<run-id>/`, screenshots/videos/traces in `automation/test-results/<run-id>/`, and
pipeline state (manifest, specs, exploration, healing log, `summary.md`) in `dependencies/runs/<run-id>/`.

## Safety and efficiency

- **No unapproved installs.** Every dependency is asked for separately, with the exact command, and logged.
- **Reuse only when provably unchanged.** Specs, generated tests, review results and exploration are reused across runs only while
  their inputs are identical (`cache status <run-id>` shows why anything was rebuilt). Execution results are never reused.
- **Agents only where judgment is needed;** everything deterministic runs through the CLI.
- **Nothing is left running.** Browsers and servers started by a run are stopped when it ends, fails or is resumed. Your own
  browsers and servers are never touched.
- **Team setup:** add the marketplace to a project's `.claude/settings.json` so everyone is offered the plugin:

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

## Updating and upgrading

Update the plugin with `/plugin marketplace update automation-builder-marketplace`, then run
`/automation-builder:init --update` in each project to refresh the engine files. Your config, tests and `playwright.config`
are left alone.

Projects scaffolded by 0.2.x (everything inside `automation/`) are migrated by `/automation-builder:init`: it shows a dry run,
and moves files only after you confirm. 0.1.x projects (scaffolded at the project root) are left untouched with a warning; move
`config/`, `tests/` and `input/` by hand if you want to keep them.
