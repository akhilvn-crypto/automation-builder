// Exploration fallback when the Playwright CLI is unavailable or not approved. Uses only the
// already-installed @playwright/test: opens one URL headless, saves its accessibility snapshot and
// a screenshot, then closes. Navigation only — no clicks, no form input.
//
//   node src/tools/aria-snapshot.ts --url http://localhost:4173/login --out output/runs/<id>/exploration/login

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

const { values } = parseArgs({ options: { url: { type: 'string' }, out: { type: 'string' } } });
if (!values.url || !values.out) {
  process.stderr.write('usage: node src/tools/aria-snapshot.ts --url <url> --out <path-without-extension>\n');
  process.exit(1);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const response = await page.goto(values.url, { waitUntil: 'load' });
  const snapshot = await page.locator('body').ariaSnapshot();
  mkdirSync(path.dirname(values.out), { recursive: true });
  writeFileSync(`${values.out}.aria.yml`, snapshot + '\n');
  await page.screenshot({ path: `${values.out}.png`, fullPage: true });
  process.stdout.write(JSON.stringify({
    ok: true, url: page.url(), status: response?.status() ?? null, title: await page.title(),
    snapshot: `${values.out}.aria.yml`, screenshot: `${values.out}.png`,
  }, null, 2) + '\n');
} finally {
  await browser.close();
}
