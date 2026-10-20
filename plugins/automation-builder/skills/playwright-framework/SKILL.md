---
name: playwright-framework
description: Shared Playwright Test framework conventions for this project — the automation/ folder layout, the language-specific shared fixtures and page objects, test titles and IDs, locator and assertion rules, lifecycle, and what generated code may and may not touch. Use when writing, reviewing or repairing Playwright tests.
user-invocable: false
---

# Playwright framework conventions

One framework for every agent. Do not create parallel configs, fixtures or helpers.

All paths are relative to the **`automation/`** folder (the framework, with its own `package.json`). The pipeline engine,
test-case input and run state live in the sibling `dependencies/` folder; never put them in `automation/`.
`<ext>` is `ts` or `js` — the language the user chose at `/automation-builder:init`, recorded as `language` in
`dependencies/state/scaffold.json` and in the run's config (`node dependencies/engine/cli/pipeline.ts run show <runId>`).
**Write only that language.** Never mix, never convert.

## Layout

The structure follows `playwright_framework_structure.md`: **`pages/`, `tests/`, `helpers/` are mandatory**; `fixtures/`,
`config/`, `test-data/`, `auth/`, `reports/`, `test-results/` exist only when they have a clear responsibility. Do not add other
top-level folders to `automation/`.

| Path | Owner | Notes |
|---|---|---|
| `playwright.config.<ext>` | framework (user-editable) | standard `defineConfig` with literal values written from `config/automation.config.json` by `config save` / `config render`; a hand-edited file is never overwritten without `--force`. Do not edit it from generated tests or healing |
| `fixtures/test.<ext>` | framework | exports `test`, `expect`; auto `diagnostics` fixture attaches console/page/network errors on failure; auto `stepEvidence` fixture (only with the `evidence-pdf` reporter) screenshots every `test.step` and the final state |
| `helpers/test-data.<ext>` | framework | `requireEnv(name)`, `uniqueSuffix(prefix)`, `redact()`. Generic, app-agnostic helpers only; page-specific behaviour belongs in `pages/` |
| `test-data/` | humans | only when needed: non-sensitive data files (JSON/CSV). Never credentials |
| `pages/BasePage.<ext>` | framework | base class for page objects (`path`, `open()`, `byTestId()`) |
| `pages/<Name>Page.<ext>` | generator | page objects extending `BasePage` (see policy below); named for the page, shared across modules |
| `tests/<module>.spec.<ext>` | generator + humans | one folder for every test, **one file per module** (see below). A file the pipeline wrote starts with the header `// @automation-builder:generated` and is the only kind it regenerates or heals; files without it are handwritten and never modified. Never overwrite a file lacking the header: choose another name |
| `auth/*.setup.<ext>` | generator | only for `auth.approach = storage-state`: logs in once and saves `auth/storage-state.json` (git-ignored; never commit it) |
| `reports/`, `test-results/` | generated | Playwright output per run (`<runId>/<label>/`); never write source code here |
| `../dependencies/engine/` | plugin | pipeline engine — never edit |

Type check (TypeScript projects): `npm run typecheck` (needs `@playwright/test`). JavaScript projects are syntax-checked
and reviewed statically. Import specifiers carry the real extension: `.ts` in TypeScript projects, `.js` in JavaScript
ones. TypeScript uses only erasable syntax (no enums, namespaces or parameter properties).

## Modules: one test file per module

The test cases belong to modules (feature areas such as Login or Create Project; `module` / `moduleSlug` in
`test-specs.json`). Tests are organised the same way: **every module has its own file, and a file holds one module only.**
Never put several modules in one `*.spec.*` file.

- Get the plan from `node dependencies/engine/cli/pipeline.ts specs modules <runId>`: per module, the file to write
  (`tests/<moduleSlug>.spec.<ext>`; if a handwritten test already has that name the plan gives `tests/<moduleSlug>.generated.spec.<ext>`
  instead), the spec IDs to generate and the ones to hold back. Use exactly those file names.
- The file wraps its tests in one `test.describe('<module name>', …)`.
- A module's page objects are named for the page (`LoginPage`, `ProjectFormPage`), not the module, because pages are shared:
  when two modules use the same page, both import the one class. A flow that spans modules (log in, then create a project)
  uses the other module's page object, never a copy of its locators.
- `generate validate` fails when a file mixes modules or a module is split over files, so a mistake is caught before review.

## Page objects (policy)

- Use a page object when the same page's locators/actions appear in **two or more** tests or specs, or one page has
  three or more interactions. Otherwise keep the locators inline in the test.
- One class per page or component in `pages/<Name>Page.<ext>`, extending `BasePage`: `readonly` locator properties built
  from `this.page` with the standard locator order, and methods for user *actions* (`signIn()`, `addToCart()`).
- **Assertions never go in page objects.** They stay in the test, mirroring the spec's expected results.
- Build locators only from exploration evidence. Navigate with a relative `path`; never an absolute URL.
- Every page object added or changed is listed in the generation manifest's `sharedFilesChanged`. The reviewer applies
  the line-level safety rules to it. The healer does **not** auto-patch page objects (they are shared); a defect found
  there is reported for the user to approve.

## Test shape

TypeScript (`tests/login.spec.ts`; first line is the ownership header):

```ts
import { test, expect } from '../fixtures/test.ts';
import { LoginPage } from '../pages/LoginPage.ts';
import { requireEnv } from '../helpers/test-data.ts';

test.describe('Login', () => {            // one describe per file: the module's name
  test('[TC-001] Valid user can sign in', { annotation: { type: 'testId', description: 'TC-001' }, tag: ['@smoke'] }, async ({ page }) => {
    const login = new LoginPage(page);
    await test.step('Open the login page', async () => {
      await login.open();                                // BasePage.open() → page.goto(path) relative to baseURL
    });
    await test.step('Enter credentials', async () => {
      await login.signIn(requireEnv('TEST_USER_EMAIL'), requireEnv('TEST_USER_PASSWORD'));
    });
    // Expected: The heading "Dashboard" is visible
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});
```

JavaScript is identical minus the types, with `.js` import specifiers (`'../fixtures/test.js'`,
`'../pages/LoginPage.js'`, `'../helpers/test-data.js'`); page objects declare `path = '/login'` as a class field and
use JSDoc (`/** @param {string} email */`) instead of annotations.

Rules:
- Title **starts with `[<testId>] `** and the `testId` annotation is set. Results, triage and healing rely on it.
- Import `test`/`expect` from `fixtures/test.<ext>`, never directly from `@playwright/test`.
- One `test.step` per spec step, using the spec's wording. Put the spec's expected result as a comment above each assertion.
- When `reporters` includes `evidence-pdf` (check `run show <runId>`), also put each expected result's assertions inside
  `await test.step('Expected: <the expected result, spec wording>', async () => { … })`. The evidence PDF then shows that
  check as its own step with the screenshot taken right after it. The assertion itself is unchanged (same locator, same
  matcher, same text); only the wrapper is added. Without that reporter keep the plain comment-above-assertion form.
  Always use `test.step` from the shared fixture (never `test.step` of `@playwright/test`), and never take screenshots by hand
  for the PDF: the fixture does it.
- Spec tags → Playwright `tag` (`@smoke`). Priority can go in an annotation.
- Locators, in order of preference: `getByRole` (with name) → `getByLabel` → `getByPlaceholder`/`getByText` →
  `getByTestId` (`data-testid`) → a scoped `locator()` as a last resort, with a comment saying why. Never XPath,
  never structural CSS, never CLI refs (`e12`).
- Web-first assertions (`await expect(locator).toBeVisible()`, `toHaveText`, `toHaveURL`). No `waitForTimeout`; no
  `isVisible()` checked inside an `if`.
- Assertions must match the spec's expected results exactly: same quoted text, same URL fragments. Don't add
  assertions for unstated behaviour.
- No `.only`, `test.skip`, `test.fixme`, `test.fail`, `@ts-ignore`, or `force: true` (unless evidence is noted in a comment).
- Each test is independent: no order dependence, no shared mutable state, a fresh context per test (the Playwright default).
- Create data with `uniqueSuffix()` and clean it up in the test, or in `afterEach` when a cleanup path exists.
  Never delete data the test didn't create.

## Execution settings (from config)

`use.baseURL`, `video`, `screenshot`, `trace`, `retries`, `workers`, `timeout` and browser projects all come from
`config/automation.config.json` (plus `PW_*` env overrides). Don't hard-code them in tests. To change one, go through
the pipeline-setup skill.
