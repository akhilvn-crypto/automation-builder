---
name: test-case-parser
description: Supported test-case input formats (Markdown, CSV, Excel .xlsx in the user's own column layout), how they are normalized into modules and test-specs.json, stable test IDs and ambiguity rules. Use when parsing, writing or fixing test-case input, or interpreting test-specs.json.
user-invocable: false
---

# Test-case input and the test-spec schema

Parser: `dependencies/engine/pipeline/test-case-parser.ts` (tables: `input-table.ts`, Excel reader: `utils/xlsx.ts`).
Schema and validator: `dependencies/engine/pipeline/test-spec.ts`. Full reference: `dependencies/docs/test-spec-schema.md`.
Examples: `dependencies/docs/examples/`.
Test cases live in `dependencies/input/test-cases/`; input paths are relative to `dependencies/`
(`input/test-cases/login.md`) and source references in the specs use the same form.

**Where the user keeps them doesn't matter.** `node dependencies/engine/cli/pipeline.ts input import --from <file-or-folder>`
(any path, absolute or relative to the shell's cwd; quotes are stripped) converts them into the format below, one Markdown
file per test case, saved as `dependencies/input/test-cases/<id>.md` (the `# Module` heading stays inside each file). An ID that
is not a valid test ID (`TC001`, `1`) or that another sheet already used (workbooks usually restart numbering on every sheet)
is prefixed with its sheet name, e.g. `TARGET-BLOCK-TC001`; `renamedIds` in the output lists them. A serial-number column
(`S. No.`) is the ID only when the sheet has no real ID column. The original is only read. Credentials and emails
become `env:VAR` references and their values go to `automation/.env`. Nothing is written if any file cannot be read; files that
already exist with different content are a `conflict` unless `--overwrite`; re-importing the same source changes nothing.
`/playwright-pipeline` runs it before creating the run.

## Supported formats (by extension)

| Format | Extensions | Notes |
|---|---|---|
| Markdown | `.md`, `.markdown` | one case per `## <ID>: <title>` heading; a `# heading` is the module |
| CSV | `.csv`, `.tsv` | `,` `;` or tab delimiter; quoted multi-line cells |
| Excel | `.xlsx` | read directly, no dependency: every sheet is a table, the sheet name is the module |

`.xls`, `.xlsm`, `.ods` and `.numbers` cannot be read: `specs parse` says so and names the fix (save as `.xlsx` or export
CSV). Password-protected workbooks cannot be read either.

## The user's own layout: normalize it, never ask them to reformat

Users keep test cases in their own spreadsheet layout. The engine converts it into the spec format; do not ask the user to
rewrite their file.

- **Header row**: found automatically (the first of the first 25 rows that has a steps and an expected-result column), so a
  title block above the table is fine. Header names are matched case- and punctuation-insensitively against a wide alias
  list: ID (`TC ID`, `Test Case No`, `Ref`), title (`Scenario`, `Test Case Name`, `Summary`, a bare `Description`),
  module (`Module`, `Feature`, `Functionality`, `Area`, `Component`), steps (`Test Steps`, `Procedure`, `Action`),
  expected (a short header starting `Expected …`), `Preconditions`/`Prerequisites`, `Test Data`, `Priority`, `Tags`.
- **Rows**: a row with an ID or title starts a case; a row with neither, or one repeating the previous ID, continues it
  (one step per row, as in merged-cell layouts). A cell holding `1. … 2. …`, `Step 1: …` or one step per line becomes
  several steps. If the expected cell has the same number of lines, they pair per step; otherwise they stay at case level
  (never guessed).
- **Heading rows**: a row inside the table with only its first (ID) cell filled and a name rather than an ID ("Login",
  "Blog Subscription/Subscription") is a module heading, not a case; the cases below it belong to that module. A lone
  ID-shaped cell (`TC-9`) is still an (incomplete) case and gets flagged.
- **Columns that match nothing** (Status, Actual Result, Remarks, S.No, …) are listed as `ignoredColumns` per sheet in the
  `specs parse` output. Read that list. If one holds real test content, tell the user and map it.
- **Sheets with no steps/expected column** (cover page, notes) are skipped and reported under `tables`. A sheet that has
  only one of the two is an error, not a silent skip.

When a layout is not recognised, `input import` and `specs parse` exit 2 and lists the columns it found. Then:

1. `node dependencies/engine/cli/pipeline.ts input inspect [--path <p>]` (an external file or folder works too) shows, per file and sheet, the header row, which
   header fed which field, the ignored columns and the modules found. It prints headers and counts, never cell values.
2. Decide which header is which field. If it is not obvious, **ask the user** (one question per ambiguous column, the
   headers as options). Never invent a mapping just to make a parse pass.
3. `… input map <file> [--sheet <name>] --column id="Code" --column steps="How to test" --column expected="Result" [--header-row N] [--module "Name"] [--skip]`
   saves it in `dependencies/state/input-mapping.json` (CLI only; never hand-edit). It is refused if the table would still
   not parse. `--clear` removes a saved mapping. Without `--sheet` it applies to the CSV, or to every sheet of a workbook.
4. Re-run `input import` (or `specs parse`).

`--module M` puts every case of the table in one module. `--module-from section|sheet|title-prefix` picks where module names
come from when there is no module column (`title-prefix` = the text before " - " in the title: "Home page - banners" → Home page).

Fields for `--column`: `id`, `title`, `module`, `preconditions`, `steps`, `expected`, `data`, `priority`, `tags`.

## Modules

Every spec has a `module` (display name) and `moduleSlug` (file-name form: "Create Project" → `create-project`). The
module is, in order: the `--module` mapping, the row's module column (an empty cell inherits the one above), the title
prefix if `--module-from title-prefix` was saved, the nearest heading row above the case, the Markdown `# heading`, the sheet
name (generic names such as `Sheet1` or `Test Cases` don't count), then the file name.

`specs parse` / `input inspect` report, per table, `moduleFrom` (which of these named the modules), `sections` (heading rows
found) and `titlePrefixes` (shared "<prefix> - " parts with case counts). When the headings are really something else (test
types such as "Functional testing" while the titles name the feature: "Home page - …") and `titlePrefixes` looks like the better
grouping, **ask the user which grouping they want** (headings / title prefix / one module for the file) and save the answer
with `input map --module-from`; do not pick silently.
Tests are generated **one file per module** (see the playwright-framework skill); `specs modules <runId>` prints the plan.

`specs parse` also writes the whole input back out as Markdown in the pipeline's own format, one file per module, to
`dependencies/runs/<runId>/normalized-input/<slug>.md`. That is the record of what was understood. It holds `env:VAR`
references instead of credentials, and a file can be copied into `input/test-cases/` to continue in the canonical format.

### Markdown
```md
# Login                           (optional; the module. Several `#` headings in one file = several modules)
## TC-001: Title                  (ID optional; without one a stable AUTO-xxxxxxxx ID is derived from path + title)
Priority: High
Tags: smoke, auth
### Preconditions
- ...
### Test Data
- email: env:TEST_USER_EMAIL       (env var NAME; the value lives in .env)
- password: literal:wrong-pass-1   (explicitly non-secret literal)
- plan: Premium                    (plain literal)
- username: qa-admin               (credential-looking literal: `specs parse` moves it to .env as TEST_USERNAME)
### Steps
1. Enter {email} in the Email field          ({name} must be defined in Test Data)
2. Click "Sign in" -> Expected: ...          (inline step expectation; also "| Expected:")
   - Expected: ...                           (or a nested bullet)
### Expected Results
- ...
```
Label lines (`Steps:`, `Expected Result: X`) work in place of `###` headings.

### CSV / Excel sheet
```csv
Module,TC ID,Test Case,Steps,Expected Result
Login,LOG-1,Valid sign in,"1. Open the login page
2. Click ""Sign in""","The login page is shown
The dashboard is shown"
Create Project,PRJ-1,Create a project,"Click ""New project""",The project form opens
```
The `Module` column is optional (the sheet or file name is used without it). Column names are the user's own; see above.

## Ambiguities

Blocking (case → `needs_clarification`, never generated): `missing_expected_result`, `missing_steps`, `empty_step`,
`duplicate_id`, `undefined_data_reference`, `possible_secret_literal`.
Warning only: `vague_expected_result` ("works correctly"). Mention it, but the case stays `ready`.

`possible_secret_literal` is now rare: credentials, usernames and emails written as literals are **moved to
`automation/.env` automatically** (see the test-data-management skill), so the spec holds `envVar: "TEST_PASSWORD"` and the
case stays `ready`. The kind remains only for values that cannot be stored in a `.env` file. Inline email addresses in step
or expected-result text are the one place wording is changed: `Enter qa@x.com in Email` becomes `Enter {email} in Email`,
with a matching Test Data entry. Use `literal:` to keep a deliberately fake value as is.

Resolving a blocking ambiguity means the **user edits the source file** (or answers, and you show them the exact
line to change). Then re-run `specs parse`. Never patch `test-specs.json`.

## Stable IDs

The source ID is used verbatim when present (pattern `PREFIX-123`, letters/digits/`_`/`-`). Otherwise
`AUTO-<sha256(path + lowercased title)[0..8]>` (the sheet name is part of the key for Excel): stable across runs, but it
changes if the title or path changes, so recommend explicit IDs. Duplicates are flagged on every occurrence; later ones
get `-dup2`, `-dup3`, … so IDs stay unique.
