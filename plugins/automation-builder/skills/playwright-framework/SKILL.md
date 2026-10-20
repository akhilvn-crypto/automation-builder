---
name: playwright-framework
description: Shared Playwright Test framework conventions for this project — the automation/ folder layout, the language-specific shared fixtures and page objects, test titles and IDs, locator and assertion rules, lifecycle, and what generated code may and may not touch. Use when writing, reviewing or repairing Playwright tests.
user-invocable: false
---

# Playwright framework conventions

One framework for every agent. Do not create parallel configs, fixtures or helpers.

All paths are relative to the **`automation/`** folder (a self-contained project with its own `package.json`).
`<ext>` is `ts` or `js` — the language the user chose at `/automation-builder:init`, recorded as `language` in
`config/scaffold.json` and in the run's config (`node automation/engine/cli/pipeline.ts run show <runId>`).
**Write only that language.** Never mix, never convert.

## Layout

| Path | Owner | Notes |
|---|---|---|
| `playwright.config.<ext>` | framework | thin wrapper; all values come from `config/automation.config.json` via `engine/config/playwright-settings.ts` |
| `fixtures/test.<ext>` | framework | exports `test`, `expect`; auto `diagnostics` fixture attaches console/page/network errors on failure |
| `utils/test-data.<ext>` | framework | `requireEnv(name)`, `uniqueSuffix(prefix)`, `redact()` |
| `pages/BasePage.<ext>` | framework | base class for page objects (`path`, `open()`, `byTestId()`) |
| `pages/<Name>Page.<ext>` | generator | page objects extending `BasePage` (see policy below) |
| `tests/generated/*.spec.<ext>` | generator | the only place generated tests are written |
| `tests/handwritten/` | humans | never modified by the pipeline |
| `tests/setup/*.setup.<ext>` | generator | only for `auth.approach = storage-state` (setup project) |
| `engine/` | plugin | pipeline engine — never edit |

Type check (TypeScript projects): `npm run typecheck` (needs `@playwright/test`). JavaScript projects are syntax-checked
and reviewed statically. Import specifiers carry the real extension: `.ts` in TypeScript projects, `.js` in JavaScript
ones. TypeScript uses only erasable syntax (no enums, namespaces or parameter properties).

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

TypeScript (`tests/generated/login.spec.ts`):

```ts
import { test, expect } from '../../fixtures/test.ts';
import { LoginPage } from '../../pages/LoginPage.ts';
import { requireEnv } from '../../utils/test-data.ts';

test.describe('Login', () => {
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

JavaScript is identical minus the types, with `.js` import specifiers (`'../../fixtures/test.js'`,
`'../../pages/LoginPage.js'`, `'../../utils/test-data.js'`); page objects declare `path = '/login'` as a class field and
use JSDoc (`/** @param {string} email */`) instead of annotations.

Rules:
- Title **starts with `[<testId>] `** and the `testId` annotation is set. Results, triage and healing rely on it.
- Import `test`/`expect` from `fixtures/test.<ext>`, never directly from `@playwright/test`.
- One `test.step` per spec step, using the spec's wording. Put the spec's expected result as a comment above each assertion.
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
