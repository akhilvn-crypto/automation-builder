# Test-spec schema (`test-specs.json`, schemaVersion 1)

Produced by `node dependencies/engine/cli/pipeline.ts specs parse <runId>` from the configured input. Source:
`engine/pipeline/test-spec.ts` (types + validator) and `engine/pipeline/test-case-parser.ts` (parser), both under
`dependencies/`. Input formats are described in the plugin's `test-case-parser` skill; examples are in
`dependencies/docs/examples/`. Source paths in the document are relative to `dependencies/`.

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-20T04:00:00.000Z",
  "sources": [{ "path": "input/test-cases/login.md", "sha256": "…", "format": "markdown" }],
  "specs": [{
    "id": "TC-001",                       // source ID, or AUTO-<8 hex> derived from path + title
    "title": "Valid user can sign in",
    "source": { "path": "input/test-cases/login.md", "line": 3, "originalId": "TC-001" },
    "suite": "Login",                     // Markdown "# heading", else null
    "priority": "High",                   // or null
    "tags": ["smoke", "auth"],
    "preconditions": ["An active test account exists"],
    "steps": [
      { "index": 1, "action": "Open the login page", "expected": null },
      { "index": 4, "action": "Click the \"Sign in\" button", "expected": "The dashboard is displayed" }
    ],
    "expectedResults": ["The heading \"Dashboard\" is visible"],
    "testData": [
      { "name": "email", "value": null, "envVar": "TEST_USER_EMAIL", "declaredLiteral": false },
      { "name": "password", "value": "wrong-pass", "envVar": null, "declaredLiteral": true }
    ],
    "ambiguities": [],                    // { kind, message, stepIndex|null }
    "status": "ready"                     // or "needs_clarification"
  }]
}
```

## Rules enforced by the validator

- IDs match `PREFIX-REST` and are unique. Duplicate source IDs are flagged on every occurrence and suffixed `-dup2`, …
- Steps are numbered 1..n. Wording is copied verbatim from the source.
- Each `testData` entry has exactly one of `value` / `envVar`; `envVar` is a variable **name**.
- Credential-looking literals (password/token/secret/API-key fields, username/email fields, any email address) are
  never stored: the parser writes `envVar: "TEST_<NAME>"` and `specs parse` puts the value in `automation/.env`.
  Email addresses typed inside steps become `{email}` placeholders with a Test Data entry. `literal:<value>` keeps a value as is.
- `status` must agree with the ambiguities, so a case can't be marked ready by hand:

| Ambiguity kind | Blocking? |
|---|---|
| `missing_expected_result`, `missing_steps`, `empty_step`, `duplicate_id`, `undefined_data_reference` | yes → `needs_clarification` |
| `possible_secret_literal` (only for a value that cannot be stored in a `.env` file) | yes → `needs_clarification` |
| `vague_expected_result` | no (warning) |

- The `test_analysis` stage completes only if the document is valid and at least one spec is ready. Specs that need
  clarification are never generated; they are reported as `blocked` tests with the reason.

## Other run artifacts

These live in `dependencies/runs/<run-id>/`. Playwright's own output (reporter files, screenshots, video, traces) is
written to the framework: `automation/reports/<run-id>/<label>/` and `automation/test-results/<run-id>/<label>/`.

| File | Schema source |
|---|---|
| `manifest.json` | `engine/pipeline/run-manager.ts` |
| `input-validation.json` | `engine/pipeline/input-validation.ts` |
| `exploration/exploration.json` | `engine/pipeline/exploration.ts` |
| `generation-manifest.json` | `engine/pipeline/generation.ts` |
| `review-report.json` | `engine/pipeline/static-review.ts` |
| `execution-results.json`, `regression-results.json`, `reruns/*.json` | `engine/pipeline/execution.ts` |
| `failure-analysis.json` | `engine/pipeline/failure-classifier.ts` |
| `healing-log.json` | `engine/pipeline/healing.ts` |
| `summary.json`, `summary.md` | `engine/pipeline/reporting.ts` |

Stage → required artifacts: `engine/pipeline/stage-contracts.ts`.
