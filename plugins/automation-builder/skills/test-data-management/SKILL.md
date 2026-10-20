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
  `config.auth.credentialEnvVars` lists the variable **names** so runner logs and diagnostics get redacted.
- A literal in a credential-looking field is flagged `possible_secret_literal` unless written `literal:<value>`
  (an intentionally fake value, e.g. a wrong password for a negative test).

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
