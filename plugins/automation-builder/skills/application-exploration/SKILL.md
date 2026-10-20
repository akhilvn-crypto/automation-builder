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
| CLI missing, install not approved, `@playwright/test` + a browser installed | fallback: `node src/tools/aria-snapshot.ts` (read-only page snapshots) |
| neither | stop; the stage is `blocked`. Do not install anything or try other tools |

## Playwright CLI

Check the installed version's syntax first: `playwright-cli --help` (or `npx playwright-cli --help` for a
project-local install). Don't assume flags. Typical flow:

1. Open a named, isolated session at the base URL, e.g. `playwright-cli -s=explore-<runId> open <baseUrl>`.
2. `snapshot` → read the accessibility tree (roles, names, element refs like `e12`).
3. For each ready spec, perform its steps in order using refs (`click e12`, `fill e5 "text"`), taking a snapshot after
   each state change. Use `$ENV_VAR` for credentials in the shell. Never type a literal secret.
4. Save evidence that matters into `output/runs/<runId>/exploration/` (`<page>.aria.yml`, `<page>.png`).
   Don't save pages showing secrets or personal data.
5. Close the session (`close` / `session-stop` per `--help`). Always close it, even after an error.

**Refs are temporary.** Translate each control you rely on into a durable locator from what the snapshot shows:
`- button "Sign in" [ref=e12]` → `getByRole('button', { name: 'Sign in' })`;
`- textbox "Email"` → `getByLabel('Email')`; a `data-testid` → `getByTestId('…')`. Confidence: **high** = unique
role+name or test id; **medium** = text/label that could repeat; **low** = needs scoping or position.

## Fallback: aria snapshot

`node src/tools/aria-snapshot.ts --url <baseUrl><path> --out output/runs/<runId>/exploration/<page>` writes
`<page>.aria.yml` + `<page>.png` for one page (navigation only, no interaction). Use it for each page the steps
reach directly by URL. Record `tool: "aria-snapshot-fallback"` and mark specs needing interaction as `partial`,
with the reason in `uncertainties`.

## Safety

- Only the configured base URL (an authorized test environment). Don't follow links to other domains.
- No destructive or irreversible actions without explicit user authorization relayed by the orchestrator. Log them in `avoidedActions`.
- Stop on login failure, a 5xx, or an unreachable host, and report it as an environment/precondition problem.

## Record

Write `exploration/exploration.json` (schema in `src/pipeline/exploration.ts`): pages (url, title, evidence paths,
elements with `candidateLocator` + confidence), per-spec steps with the observation and the locators used, and
`uncertainties`. Validate with `node src/cli/pipeline.ts explore validate <runId>`.
