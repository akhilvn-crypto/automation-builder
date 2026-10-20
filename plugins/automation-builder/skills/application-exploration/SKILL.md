---
name: application-exploration
description: CLI-first application exploration with the official Playwright CLI (named session, accessibility snapshots, targeted interaction), the approved aria-snapshot fallback, evidence capture and translating observations into durable locators recorded in exploration.json. Use when exploring the app or re-checking current UI during healing.
user-invocable: false
---

# Application exploration

Exploration is **observation**, not the test runner and not a source of requirements.

## Tool selection

Read `exploration.tool` from the run config and the `@playwright/cli` preflight check.

| Situation | Do |
|---|---|
| `playwright-cli` and the CLI is installed (project or global) | use the Playwright CLI (below) |
| CLI missing, install not approved, `@playwright/test` + a browser installed | fallback: `node dependencies/engine/tools/aria-snapshot.ts` (read-only page snapshots) |
| neither | stop; the stage is `blocked`. Do not install anything or try other tools |

## Playwright CLI

Run the CLI from the **`dependencies/`** folder, not from `automation/`: it writes session files (`.playwright-cli/`)
into the current directory, and `automation/` must stay framework-only. A project-local install lives in
`automation/node_modules`, so call it by path (`../automation/node_modules/.bin/playwright-cli …`); a global install is
just `playwright-cli …`. Evidence goes to `runs/<runId>/exploration/…` (relative to `dependencies/`); `exploration.json`
records those files relative to the run directory (`exploration/<page>.aria.yml`).

Check the installed version's syntax first: `playwright-cli --help` (or the same with the project-local path). Don't assume flags. Typical flow:

1. Open a named, isolated session at the base URL, e.g. `playwright-cli -s=explore-<runId> open <baseUrl>`.
2. `snapshot` → read the accessibility tree (roles, names, element refs like `e12`).
3. For each ready spec, perform its steps in order using refs (`click e12`, `fill e5 "text"`), taking a snapshot after
   each state change. Never type a literal secret. Credential values live in `automation/.env` (filled in by
   `specs parse`; `env check <runId>` already confirmed every needed name has a value), and your shell does not load that file.
   Run the step through the pipeline CLI instead, which loads `.env` for that one command and masks the values in its
   output, and keep `$VAR` inside single quotes so the child shell expands it, not yours:
   `node ../dependencies/engine/cli/pipeline.ts env run -- sh -c 'playwright-cli -s=explore-<runId> fill e5 "$TEST_PASSWORD"'`
   (adjust the path to the CLI to where you run it from). Never print or echo a value to check it. Do not `source` the file.
4. Save evidence that matters into `dependencies/runs/<runId>/exploration/` (`<page>.aria.yml`, `<page>.png`).
   Don't save pages showing secrets or personal data.
5. Close the session (`close` / `session-stop` per `--help`). Always close it, even after an error.

**Refs are temporary.** Translate each control you rely on into a durable locator from what the snapshot shows:
`- button "Sign in" [ref=e12]` → `getByRole('button', { name: 'Sign in' })`;
`- textbox "Email"` → `getByLabel('Email')`; a `data-testid` → `getByTestId('…')`. Confidence: **high** = unique
role+name or test id; **medium** = text/label that could repeat; **low** = needs scoping or position.

## Fallback: aria snapshot

`node dependencies/engine/tools/aria-snapshot.ts --url <baseUrl><path> --out runs/<runId>/exploration/<page>` (`--out` is relative to `dependencies/`) writes
`<page>.aria.yml` + `<page>.png` for one page (navigation only, no interaction). Use it for each page the steps
reach directly by URL. Record `tool: "aria-snapshot-fallback"` and mark specs needing interaction as `partial`,
with the reason in `uncertainties`.

## Safety

- Only the configured base URL (an authorized test environment). Don't follow links to other domains.
- No destructive or irreversible actions without explicit user authorization relayed by the orchestrator. Log them in `avoidedActions`.
- Stop on login failure, a 5xx, or an unreachable host, and report it as an environment/precondition problem.

## Record

Write `exploration/exploration.json` (schema in `engine/pipeline/exploration.ts`): pages (url, title, evidence paths,
elements with `candidateLocator` + confidence), per-spec steps with the observation and the locators used, and
`uncertainties`. Validate with `node dependencies/engine/cli/pipeline.ts explore validate <runId>`.
