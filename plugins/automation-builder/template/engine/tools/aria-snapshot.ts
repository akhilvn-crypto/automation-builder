// Exploration fallback when the Playwright CLI is unavailable or not approved. Uses only the
// already-installed @playwright/test: opens one URL headless, saves its accessibility snapshot and
// a screenshot, then closes. Navigation only — no clicks, no form input.
//
//   node automation/engine/tools/aria-snapshot.ts --url http://localhost:4173/login --out output/runs/<id>/exploration/login
//
// --out is relative to the automation/ folder, whatever the caller's working directory is.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join('/');

const { values } = parseArgs({ options: { url: { type: 'string' }, out: { type: 'string' } } });
if (!values.url || !values.out) {
  process.stderr.write('usage: node automation/engine/tools/aria-snapshot.ts --url <url> --out <path-without-extension>\n');
  process.exit(1);
}
const out = path.resolve(ROOT, values.out);

const browser = await chromium.launch();
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
