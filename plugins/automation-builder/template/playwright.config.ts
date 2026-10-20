// Single Playwright Test configuration. All values come from config/automation.config.json
// (+ env overrides) through src/config/playwright-settings.ts — change settings there, not here.

import { createRequire } from 'node:module';
import { defineConfig, devices } from '@playwright/test';
import { loadConfig } from './src/config/load-config.ts';
import { playwrightSettings } from './src/config/playwright-settings.ts';

const rootDir = import.meta.dirname;

// Secrets live in .env (git-ignored). Node's built-in loader; no dotenv dependency.
try {
  process.loadEnvFile(`${rootDir}/.env`);
} catch {
  // no .env file: credentials may come from the real environment
}

const state = loadConfig(rootDir);
if (state.status !== 'valid') {
  throw new Error(
    `config/automation.config.json is ${state.status}: ${state.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}. ` +
      'Run /playwright-pipeline (or the pipeline-setup skill) to configure it.',
  );
}

const require = createRequire(import.meta.url);
const s = playwrightSettings(state.config, {
  rootDir,
  env: process.env,
  isInstalled: (pkg) => {
    try {
      require.resolve(pkg);
      return true;
    } catch {
      return false;
    }
  },
});

const DEVICES = { chromium: devices['Desktop Chrome'], firefox: devices['Desktop Firefox'], webkit: devices['Desktop Safari'] };

export default defineConfig({
  testDir: s.testDir,
  testMatch: s.testMatch,
  testIgnore: s.testIgnore,
  outputDir: s.outputDir,
  timeout: s.timeout,
  retries: s.retries,
  workers: s.workers,
  forbidOnly: true,
  fullyParallel: true,
  reporter: s.reporter,
  use: s.use,
  projects: s.projects.map((p) => ({
    name: p.name,
    ...(p.testMatch ? { testMatch: p.testMatch } : {}),
    ...(p.dependencies ? { dependencies: p.dependencies } : {}),
    use: { ...(p.browser ? DEVICES[p.browser] : {}), ...(p.storageState ? { storageState: p.storageState } : {}) },
  })),
});
