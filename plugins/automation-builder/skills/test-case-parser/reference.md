# Test-case input reference (read on demand)

## Header aliases (matched case- and punctuation-insensitively)

- ID: `TC ID`, `Test Case No`, `Ref`
- title: `Scenario`, `Test Case Name`, `Summary`, a bare `Description`
- module: `Module`, `Feature`, `Functionality`, `Area`, `Component`
- steps: `Test Steps`, `Procedure`, `Action`
- expected: a short header starting `Expected …`
- also `Preconditions`/`Prerequisites`, `Test Data`, `Priority`, `Tags`

The header row is the first of the first 25 rows that has both a steps and an expected-result column, so a title block above
the table is fine. A lone ID-shaped cell (`TC-9`) in an otherwise empty row is an (incomplete) case and is flagged, not a heading.

## Markdown

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

## CSV / Excel sheet

```csv
Module,TC ID,Test Case,Steps,Expected Result
Login,LOG-1,Valid sign in,"1. Open the login page
2. Click ""Sign in""","The login page is shown
The dashboard is shown"
Create Project,PRJ-1,Create a project,"Click ""New project""",The project form opens
```

The `Module` column is optional (the sheet or file name is used without it). Column names are the user's own. CSV delimiters:
`,` `;` or tab; quoted multi-line cells are supported.
