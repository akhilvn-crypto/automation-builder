---
name: test-data-management
description: Rules for test data — env-var credential references, literal vs secret values, unique data per test, isolation, auth state, and cleanup. Use whenever test data, credentials, accounts or created records are involved.
user-invocable: false
---

# Test data management

## Credentials and secrets
- Specs reference secrets as `env:VAR_NAME`. Values live only in `automation/.env` (git-ignored) or the real environment.
  `automation/.env.example` lists names with empty values.
- In tests: `requireEnv('VAR_NAME')` from `helpers/test-data.<ext>`. It fails with a clear message when the
  variable is unset, and the failure is classified as `test_data_or_precondition`, not a script defect.
- Never write a secret into tests, config, logs, reports, exploration files, commit messages or chat output.
  `config.auth.credentialEnvVars` lists the variable **names** so runner logs and diagnostics get redacted; variables
  the pipeline creates itself (below) are tracked in `dependencies/state/managed-env.json` and redacted too.

### Credentials found in the test cases are moved to `.env` automatically
Do **not** ask the user to supply credentials, emails or usernames that the test cases already contain. `specs parse`:
- treats a Test Data literal as account data when its name is a password/token/secret/API-key field, a username/email
  field, or when the value is an email address; and replaces email addresses typed inside steps with a `{email}`
  placeholder backed by a new Test Data entry;
- names the variable `TEST_<DATA_NAME>` (e.g. `TEST_PASSWORD`, `TEST_EMAIL`), adding the case ID when two cases need the
  same name for different values (`TEST_PASSWORD_TC_2`); names the user wrote as `env:VAR` are never reused for a detected value;
- writes `VAR=value` to `automation/.env` (creating it, and a `.env` line in `automation/.gitignore`, if needed), adds the
  name only to `.env.example`, and keeps just the name in `test-specs.json`. A value already present in `.env` is never overwritten:
  the user's `.env` wins, and the command reports it as `keptExisting`;
- reports names only (`env.created`, `env.filled`, `env.keptExisting`, `env.missing`); values never appear in CLI output or chat.

Generated tests then read the value with `requireEnv('TEST_PASSWORD')` as always.

### When a value is missing, point the user to `.env`
A referenced variable with no value in `.env` or the environment (for example `env:TEST_ADMIN_EMAIL` written by the user,
or a field with no value at all) is `missing`. `specs parse` has already added an empty `NAME=` line for it. Run
`node dependencies/engine/cli/pipeline.ts env check <runId>`; if it exits 2, stop the stage as `blocked` and tell the user
**which names to fill in and where** (`automation/.env`), using the command's `action` text. Never ask for the value in chat,
never write a made-up one, and re-run `env check` after they say it is done.

### Opting out
`- password: literal:wrong-pass-1` marks an intentionally fake value (a wrong password for a negative test, an invalid
email): it stays in the spec as a literal. A value that cannot be stored in a `.env` file (multi-line, or containing all
of `'`, `"` and a backtick) stays `possible_secret_literal`; tell the user to put it in `.env` themselves and write `env:VAR_NAME`.

## Auth approaches (`config.auth.approach`)
- `none`: no login.
- `ui-login`: each test logs in through the UI with `requireEnv` credentials. Simplest; use while suites are small.
- `storage-state`: an `auth/auth.setup.<ext>` setup project logs in once and saves `auth/storage-state.json`
  (git-ignored); browser projects depend on it. Create the `auth/` folder only for this approach. If the state looks expired (redirect to login), re-run setup.
  Never commit or copy that file.

## Isolation
- Each test creates what it needs, with `uniqueSuffix('order')`-style names, so parallel workers and reruns don't collide.
- Never rely on another test's data or on execution order.
- Shared reference data (an existing product, a seeded account) must be named in the spec's preconditions.
  The pipeline doesn't create or modify shared data automatically.

## Cleanup
- Delete only records the test created, through the app's normal UI/API, in the test or `afterEach`.
- If no cleanup path exists, say so in the generation report. Never delete data you didn't create, and never run
  bulk deletes.
- Non-sensitive fixture data (JSON/CSV) goes in `automation/test-data/`, created only when a test needs it. Never put credentials there.
- Run state (`dependencies/runs/`) and run output (`automation/reports/<runId>/`, `automation/test-results/<runId>/`) is removed
  only by the explicit `retention.keepRuns` policy.
