// Exploration fallback when the Playwright CLI is unavailable or not approved. Uses only the
// already-installed @playwright/test: opens one URL headless, saves its accessibility snapshot and
// a screenshot, then closes. Navigation only — no clicks, no form input.
//
//   node dependencies/engine/tools/aria-snapshot.ts --url http://localhost:4173/login --out runs/<id>/exploration/login
//
// --out is relative to the dependencies/ folder, whatever the caller's working directory is. @playwright/test is
// resolved from automation/ (where it is installed), not from this file's location.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const DEPENDENCIES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FRAMEWORK = path.join(path.dirname(DEPENDENCIES), 'automation');
const rel = (abs: string) => path.relative(DEPENDENCIES, abs).split(path.sep).join('/');

interface Page {
  goto(url: string, o: { waitUntil: 'load' }): Promise<{ status(): number } | null>;
  locator(selector: string): { ariaSnapshot(): Promise<string> };
  screenshot(o: { path: string; fullPage: boolean }): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
}
interface Playwright {
  chromium: { launch(): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }> };
}

const { values } = parseArgs({ options: { url: { type: 'string' }, out: { type: 'string' } } });
if (!values.url || !values.out) {
  process.stderr.write('usage: node dependencies/engine/tools/aria-snapshot.ts --url <url> --out <path-without-extension>\n');
  process.exit(1);
}
const out = path.resolve(DEPENDENCIES, values.out);

let playwright: Playwright;
try {
  playwright = createRequire(path.join(FRAMEWORK, 'package.json'))('@playwright/test') as Playwright;
} catch {
  process.stderr.write(`@playwright/test is not installed in ${FRAMEWORK}\n`);
  process.exit(1);
}

const browser = await playwright.chromium.launch();
try {
  const page = await browser.newPage();
  const response = await page.goto(values.url, { waitUntil: 'load' });
  const snapshot = await page.locator('body').ariaSnapshot();
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(`${out}.aria.yml`, snapshot + '\n');
  await page.screenshot({ path: `${out}.png`, fullPage: true });
  process.stdout.write(JSON.stringify({
    ok: true, url: page.url(), status: response?.status() ?? null, title: await page.title(),
    snapshot: rel(`${out}.aria.yml`), screenshot: rel(`${out}.png`),
  }, null, 2) + '\n');
} finally {
  await browser.close();
}
