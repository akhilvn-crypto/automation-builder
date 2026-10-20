---
name: test-case-parser
description: Supported test-case input formats (Markdown, CSV/Excel export), the normalized test-spec schema, stable test IDs and ambiguity rules. Use when parsing, writing or fixing test-case input, or interpreting test-specs.json.
user-invocable: false
---

# Test-case input and the test-spec schema

Parser: `engine/pipeline/test-case-parser.ts`. Schema and validator: `engine/pipeline/test-spec.ts`. Full reference:
`docs/test-spec-schema.md`. Examples: `docs/examples/`.

## Supported formats (by extension)

| Format | Extensions | Notes |
|---|---|---|
| Markdown | `.md`, `.markdown` | one case per `## <ID>: <title>` heading |
| CSV | `.csv` | Excel/Sheets "Save as CSV"; `,` or `;` delimiter; quoted multi-line cells |

`.xlsx` is **not** read directly (it would need a new dependency). Ask the user to export the sheet to CSV, or to
approve a parser dependency explicitly.

### Markdown
```md
# Suite name                      (optional, becomes spec.suite)
## TC-001: Title                  (ID optional; without one a stable AUTO-xxxxxxxx ID is derived from path + title)
Priority: High
Tags: smoke, auth
### Preconditions
- ...
### Test Data
- email: env:TEST_USER_EMAIL       (env var NAME; the value lives in .env)
- password: literal:wrong-pass-1   (explicitly non-secret literal)
- plan: Premium                    (plain literal)
### Steps
1. Enter {email} in the Email field          ({name} must be defined in Test Data)
2. Click "Sign in" -> Expected: ...          (inline step expectation; also "| Expected:")
   - Expected: ...                           (or a nested bullet)
### Expected Results
- ...
```
Label lines (`Steps:`, `Expected Result: X`) work in place of `###` headings.

### CSV
Header aliases (case-insensitive): ID (`Test Case ID`, `TC ID`), title (`Test Case Title`, `Scenario`, `Summary`),
`Preconditions`, steps (`Test Steps`, `Action`), expected (`Expected Result`), `Test Data`, `Priority`, `Tags`.
A row with empty ID and title continues the previous case (one step per row). A single cell with numbered lines holds
several steps; if the expected cell has the same number of lines they are paired per step, otherwise they stay at
case level (never guessed).

## Ambiguities

Blocking (case → `needs_clarification`, never generated): `missing_expected_result`, `missing_steps`, `empty_step`,
`duplicate_id`, `undefined_data_reference`, `possible_secret_literal`.
Warning only: `vague_expected_result` ("works correctly"). Mention it, but the case stays `ready`.

Resolving a blocking ambiguity means the **user edits the source file** (or answers, and you show them the exact
line to change). Then re-run `specs parse`. Never patch `test-specs.json`.

## Stable IDs

The source ID is used verbatim when present (pattern `PREFIX-123`, letters/digits/`_`/`-`). Otherwise
`AUTO-<sha256(path + lowercased title)[0..8]>`: stable across runs, but it changes if the title or path changes, so
recommend explicit IDs. Duplicates are flagged on every occurrence; later ones get `-dup2`, `-dup3`, … so IDs stay unique.
