# Test-spec schema (`test-specs.json`, schemaVersion 1)

Produced by `node src/cli/pipeline.ts specs parse <runId>` from the configured input. Source:
`src/pipeline/test-spec.ts` (types + validator) and `src/pipeline/test-case-parser.ts` (parser).
Input formats are described in `.claude/skills/test-case-parser/SKILL.md`; examples are in `docs/examples/`.

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
- `status` must agree with the ambiguities, so a case can't be marked ready by hand:

| Ambiguity kind | Blocking? |
|---|---|
| `missing_expected_result`, `missing_steps`, `empty_step`, `duplicate_id`, `undefined_data_reference`, `possible_secret_literal` | yes → `needs_clarification` |
| `vague_expected_result` | no (warning) |

- The `test_analysis` stage completes only if the document is valid and at least one spec is ready. Specs that need
  clarification are never generated; they are reported as `blocked` tests with the reason.

## Other run artifacts

| File | Schema source |
|---|---|
| `manifest.json` | `src/pipeline/run-manager.ts` |
| `input-validation.json` | `src/pipeline/input-validation.ts` |
| `exploration/exploration.json` | `src/pipeline/exploration.ts` |
| `generation-manifest.json` | `src/pipeline/generation.ts` |
| `review-report.json` | `src/pipeline/static-review.ts` |
| `execution-results.json`, `regression-results.json`, `reruns/*.json` | `src/pipeline/execution.ts` |
| `failure-analysis.json` | `src/pipeline/failure-classifier.ts` |
| `healing-log.json` | `src/pipeline/healing.ts` |
| `reports/summary.json` | `src/pipeline/reporting.ts` |

Stage → required artifacts: `src/pipeline/stage-contracts.ts`.
