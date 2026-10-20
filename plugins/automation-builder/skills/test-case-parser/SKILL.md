---
name: test-case-parser
description: Supported test-case input formats (Markdown, CSV, Excel .xlsx in the user's own column layout), how they are normalized into modules and test-specs.json, stable test IDs and ambiguity rules. Use when parsing, writing or fixing test-case input, or interpreting test-specs.json.
user-invocable: false
---

# Test-case input and the test-spec schema

Parser: `dependencies/engine/pipeline/test-case-parser.ts` (tables: `input-table.ts`, Excel: `utils/xlsx.ts`). Schema and
validator: `test-spec.ts`; full schema reference `dependencies/docs/test-spec-schema.md`; examples `dependencies/docs/examples/`.
Input paths are relative to `dependencies/` (`input/test-cases/login.md`); spec `source` references use the same form.
Markdown/CSV syntax examples, header aliases and row rules: [reference.md](reference.md) (read only when writing or debugging input).

**Where the user keeps the test cases doesn't matter, and never ask them to reformat.**
`node dependencies/engine/cli/pipeline.ts input import --from <file-or-folder>` (any path; quotes are stripped) converts
them to one Markdown file per module in `dependencies/input/test-cases/`. The original is only read. Credentials and emails
become `env:VAR` references with their values in `automation/.env`. IDs that are invalid (`TC001`, `1`) or reused by another
sheet get the sheet name as prefix (`TARGET-BLOCK-TC001`; listed in `renamedIds`). A serial-number column (`S. No.`) is the ID
only when there is no real ID column. Nothing is written if any file is unreadable; existing files with different content are a
`conflict` unless `--overwrite`; re-importing the same source changes nothing. `/playwright-pipeline` runs it before the run.

Formats: `.md`/`.markdown` (one case per `## <ID>: <title>`, a `# heading` is the module), `.csv`/`.tsv`, `.xlsx` (every sheet
is a table, the sheet name the module; read directly, no dependency). `.xls`, `.xlsm`, `.ods`, `.numbers` and password-protected
workbooks cannot be read: say so and name the fix (save as `.xlsx` or export CSV).

## Spreadsheet layouts

The engine finds the header row (within the first 25 rows) and matches headers to fields case/punctuation-insensitively
(ID, title, module, steps, expected, preconditions, data, priority, tags). A row with an ID or title starts a case; one with
neither (or repeating the ID) continues it. `1. … 2. …` / `Step 1:` / one-per-line cells become several steps; expected
results pair per step only when the line counts match, otherwise they stay at case level (never guessed). A row with only a
name in the ID cell is a module heading, not a case.

- **Read `ignoredColumns`** (per sheet, in the `specs parse` output): Status, Actual Result, Remarks… are ignored. If one holds
  real test content, tell the user and map it.
- Sheets with no steps/expected column (cover page, notes) are skipped and listed under `tables`; a sheet with only one of
  the two is an error.

If a layout is not recognised, `input import` / `specs parse` exit 2 and list the columns found. Then:

1. `… input inspect [--path <p>]` shows per file/sheet the header row, header→field mapping, ignored columns and modules
   (headers and counts, never cell values; external paths work).
2. Decide which header is which field. If unclear, **ask the user** (one question per ambiguous column, headers as options).
   Never invent a mapping to make a parse pass.
3. `… input map <file> [--sheet <name>] --column id="Code" --column steps="How to test" --column expected="Result" [--header-row N] [--module "Name"] [--skip]`
   saves it in `dependencies/state/input-mapping.json` (CLI only; refused if the table still wouldn't parse; `--clear` removes
   it; without `--sheet` it applies to the CSV or every sheet). Fields: `id title module preconditions steps expected data priority tags`.
4. Re-run `input import` (or `specs parse`).

## Modules

Every spec has `module` and `moduleSlug` (`Create Project` → `create-project`). `--module M` puts a whole table in one module;
`--module-from section|sheet|title-prefix` picks the source when there is no module column (`title-prefix` = text before " - ":
"Home page - banners" → Home page). Without a mapping the order is: module column (empty inherits the cell above), heading row
above the case, Markdown `# heading`, sheet name (generic ones like `Sheet1` don't count), file name.

`specs parse` / `input inspect` report per table `moduleFrom`, `sections` and `titlePrefixes`. When headings are really test
types ("Functional testing") while titles name the feature ("Home page - …") and `titlePrefixes` looks better, **ask the user
which grouping they want** (headings / title prefix / one module per file), save it with `input map --module-from`; never pick
silently. Tests are generated one file per module (`specs modules <runId>` prints the plan; playwright-framework skill).
`specs parse` also writes the input back as Markdown per module to `dependencies/runs/<runId>/normalized-input/<slug>.md`
(the record of what was understood; `env:VAR` instead of credentials).

## Ambiguities

Blocking (case → `needs_clarification`, never generated): `missing_expected_result`, `missing_steps`, `empty_step`,
`duplicate_id`, `undefined_data_reference`, `possible_secret_literal`. Warning only: `vague_expected_result` ("works
correctly"): mention it, the case stays `ready`.

`possible_secret_literal` is rare: credentials, usernames and emails written as literals are moved to `automation/.env`
automatically (test-data-management skill), so the spec holds `envVar: "TEST_PASSWORD"` and the case stays `ready`; the kind
remains for values that cannot live in a `.env`. Inline emails in step/expected text are the one wording change: `Enter qa@x.com
in Email` becomes `Enter {email} in Email` with a matching Test Data entry. `literal:` keeps a deliberately fake value as is.

Resolving a blocking ambiguity means the **user edits the source** (or answers and you show the exact line to change), then
re-run `specs parse`. Never patch `test-specs.json`.

## Stable IDs

A source ID (`PREFIX-123`; letters, digits, `_`, `-`) is used verbatim. Otherwise `AUTO-<sha256(path + lowercased title)[0..8]>`
(the sheet name is part of the key for Excel): stable, but it changes when title or path change, so recommend explicit IDs.
Duplicates are flagged on every occurrence; later ones get `-dup2`, `-dup3`, …
