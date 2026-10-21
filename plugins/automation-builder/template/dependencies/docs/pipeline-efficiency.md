# Pipeline efficiency: behaviour, trade-offs and limits

How the pipeline avoids repeated work, uses agents sparingly, handles saved login state, runs things in parallel and controls
reporting volume. It describes what the code does, not what it measured: **no speed-up is claimed here**. Judge any change by
running the same suite twice and comparing (`run compare`, below).

CLI: `node dependencies/engine/cli/pipeline.ts` (`pl` below). Run state is in `dependencies/runs/<run-id>/`; caches in
`dependencies/state/` (git-ignored, local to the machine).

## 1. Run metrics and exploration reuse

- **Metrics:** every stage attempt is recorded in the manifest, so `run metrics <runId>` (also written to `metrics.json` by
  `run finalize`) reports duration, final status, attempts and interrupted attempts per stage, artifact sizes, retries, healing
  attempts, report time, cache decisions and agent calls. `run baseline` ranks stages by median completed duration.
- **Exploration reuse:** saved observations (`state/exploration-store/`, per base-URL origin) are evidence to re-check, not truth.
  `explore plan` decides per test case: `explore`, `revalidate` (one fresh snapshot confirms each saved role + name) or `reuse`. A changed
  test case, an unknown/stale/ambiguous locator or a locator that failed in execution is explored again; the reason is recorded.

## 2. Cross-run artifact reuse

Entries live in `state/artifact-cache/<kind>/<name>.json`:

| Kind | Name | Reused instead of | Depends on |
|---|---|---|---|
| `specs` | hash of the input path | parsing the test-case files | content of every input file, the saved column mappings, parser source, test-spec schema |
| `generation` | test ID | calling the generator for that test | that test case, its application evidence, language and auth approach, the plugin version (generator rules), the framework files **that test imports**, and the test's own source block |
| `review` | test ID | the reviewer agent for that test | the test's source block, its test case and evidence, static-review rules, plugin version (reviewer rules), the framework files it imports |
| `typecheck` | `framework` | the TypeScript project check | every file `automation/tsconfig.json` includes (and the engine config code), TypeScript and Playwright versions; only a pass is cached |

Exploration observations keep their own store; their reuse is listed in the same per-run ledger. **Execution results are never cached.**
Credential values found in test cases are never cached: a cache hit leaves `.env` as the first parse wrote it (use `--no-cache` to
read the values again).

An entry is reused only when it parses, has the current schema, was validated, its payload still hashes to the recorded hash, every
recorded input and version equals the current one, and the caller's own check passes (a generated test is still in a pipeline-owned
file, exactly as it was reviewed). Otherwise the artifact is rebuilt and the reason recorded.

| Change | What is rebuilt |
|---|---|
| a test-case file or a column mapping | the parse, and only the tests whose own case changed (per-test fingerprint) |
| parser or test-spec schema (source change) | the parse |
| application evidence for one test | that test's generation and review |
| a fixture, page object or helper a test imports (directly or transitively) | the tests whose block uses it; another module's page object touches nothing |
| plugin update (new generator/reviewer rules) or `tsconfig` change | every generated test (and its review) |
| a generated test edited, removed, or its ownership header deleted | that test is regenerated (hand edits to pipeline-owned files are not preserved: take the file over by deleting the header line) |
| a healed test | its cache entry is moved to the healed source after the rerun passed |

`cache status <runId>` lists hits per kind and every rebuild with its reason; `cache inspect <kind> <name>` shows one entry's inputs and
versions. Flags: `--no-cache` on `specs parse`, `generate plan`, `review static|plan|seal`; `generate plan --force`.

**Generation flow:** `generate plan` (one batch per module file) → generator agent(s) only for tests marked `generate` → `generate assemble`
(merges the batch manifests and the reused tests into `generation-manifest.json`) → `generate validate` → review → `review seal` (the point
where tests become reusable: only validated and reviewed work is cached; sealing is refused if a test the plan skipped changed meanwhile).

## 3. Agents only where judgment is needed

`agents plan <runId> <stage>` decides in code and writes the brief the agent gets (`briefs/*.json`, bounded: lists are cut to 25 items and
the whole brief to 40 KB, with the cut reported).

| Stage | Runs without an agent when | Otherwise |
|---|---|---|
| test_analysis | every case parsed without ambiguity and every input table was read cleanly | test-analyst gets the ambiguous cases and the noted tables |
| application_exploration | every case has evidence already revalidated in this run | explorer gets only cases to explore/revalidate |
| test_generation | every test is reusable | one generator per module batch, each with only its tests and evidence |
| script_review | every test has a valid earlier review | reviewer gets only the other tests |
| failure_triage | no failures, or all high-confidence from clear evidence | healer (Phase A) gets only the uncertain failures |
| healing | no eligible script defect | healer gets, per test, the failure, the test's own source block, its case and evidence |
| execution, regression_validation, report_generation, finalization, setup stages | always | (the CLI runs them) |

Invocations are recorded with `agents record` (tokens only when reported) and appear in `run metrics`. `review seal` refuses to record a
review as done if the plan required the reviewer and no invocation was recorded.

## 4. Saved login state

With `auth.approach: storage-state`, `exec run` first decides *reuse* or *refresh*. Reuse requires `auth/storage-state.json` to be
well-formed, created by the pipeline (a small record next to it holds only time, origin and variable names), for the same origin, no older
than `auth.state.maxAgeHours` (default 8), with not every cookie expired, and, when `auth.state.probePath` is set, accepted by the
application (one request with the state's cookies; only the status and redirect target are looked at). Otherwise the stale file is removed
and the setup project logs in. The generated `playwright.config.*` leaves the setup project out only when the executor sets
`PIPELINE_AUTH_STATE=reuse`, so a plain `npx playwright test` always logs in.

If reused state is rejected during the run (tests fail as logged out) the run is diagnosed (`authState.diagnosis`), the state discarded and
the tests run again **once** with a fresh login. A failing login is a `runnerError`. A test still logged out after a fresh login is classified
`test_data_or_precondition` and never offered for healing.

Limits: without a probe, reuse rests on age and cookie expiry (`verifiedByApplication: false`). Apps that answer 200 with a login page cannot
be detected before the run; the age limit and the mid-run check catch them. `auth.state.loggedOutPattern` replaces the generic heuristic.
Secrets: `.env` and `auth/storage-state*.json` must be git-ignored (preflight `secrets-ignored`); logs, errors and diagnostics mask configured
secrets and credential-shaped text.

## 5. Parallelism

- **Workers:** `execution.workers` unset means 2 (not Playwright's CPU-based default). The executor passes `PW_WORKERS` from the plan.
- **Isolation** (`execution.isolation`): `serial` = 1 worker; `shared-readonly` = tests never change shared data, tests in a file may run in
  parallel; `per-worker-accounts` = one login per worker (`NAME_1..NAME_N` in `automation/.env`, needs `ui-login`; workers are capped at the
  number of complete accounts). Unset: files in parallel, tests inside a file in order, with a warning when workers share one account. A shared
  storage-state session cannot be combined with per-worker accounts (validation rejects it).
- **Run state:** every read-modify-write of a manifest, the observation store, the cache ledger, agent usage, the healing log and the
  dependency log holds a per-file lock, so concurrent CLI processes cannot lose each other's updates.
- **Parallel generation:** one batch per module file, so batches own disjoint files. `generate assemble` refuses two batches that wrote the same
  file or test or changed the same shared file, and says to rerun them one after another. It detects this from the batch manifests; it cannot
  stop an agent from writing a file it does not own.
- **Measuring:** `run compare <baselineRunId> <candidateRunId>` returns `incorrect` if any baseline test went missing or got worse (including
  passed → flaky), `not_comparable` for unfinished runs or different commands, otherwise `faster`, `slower` or `similar` (within 10 %).

## 6. Reporting

`reporting.mode` is saved with the configuration and only constrains what the user chose:

| Mode | Requires / forbids | Intended for |
|---|---|---|
| `standard` | html + json; no allure/evidence-pdf; no record-everything video/screenshot/trace | development runs |
| `full` | html + json + allure; any evidence settings | team testing and CI |
| `audit` | full; plus opt-in `reporting.stepScreenshots` and the `evidence-pdf` reporter (which needs step screenshots) | sign-off |

`config mode-preset <mode> [--step-screenshots] [--evidence-pdf]` prints a valid proposal; `config report-plan` lists the software the chosen
reporters need and what is missing. Nothing is installed without a separate approval. `report build` keeps `reportGeneration` (did each selected
reporter produce its files, how long, how many files and bytes) apart from `counts`, verifies the files exist before saying a report was
generated, builds only selected reporters, and records which result files the reports came from. Step screenshots mask password fields and
`reporting.maskSelectors`; visible page data is not masked.

## Known limits

- A fixture change touches every test (all tests import `test`); a page object or helper change touches only the tests whose block uses it
  (matched by the imported names). Static relative imports and re-exports are followed; dynamic `import()` and package imports are not.
- The generator and reviewer rules live in the plugin, so their "version" is the plugin version recorded in `state/scaffold.json`: any plugin update
  regenerates and re-reviews every test once.
- Locks are advisory and assume short critical sections; a lock older than 30 s is treated as abandoned.
- The live probe, the evidence PDF and step-screenshot masking were exercised against a local demo app with the real Playwright; behaviour against
  other applications (SSO, SPA logins that answer 200) may differ.
