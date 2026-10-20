// Maps the validated automation config to Playwright Test options. Pure: no @playwright/test import,
// so it is unit-tested without Playwright installed. playwright.config.ts is a thin wrapper around it.
//
// Run-scoped output: when PIPELINE_RUN_DIR (absolute run dir) and PIPELINE_LABEL are set by the
// executor, reports go to <run>/reports/<label>/ and evidence to <run>/evidence/<label>/.
// Otherwise (plain `npx playwright test`) Playwright's usual playwright-report/ and test-results/.

import path from 'node:path';
import type { AutomationConfig, Browser } from './schema.ts';

export const AUTH_STATE_FILE = '.auth/storage-state.json';

export type ReporterEntry = [string] | [string, Record<string, unknown>];

export interface PlaywrightSettings {
  testDir: string;
  testMatch: string[];
  testIgnore: string[];
  outputDir: string;
  reportsDir: string;
  timeout: number;
  retries: number;
  workers: number | undefined;
  reporter: ReporterEntry[];
  missingReporters: string[]; // selected but adapter not installed — surfaced by report_generation
  use: {
    baseURL: string;
    video: AutomationConfig['evidence']['video'];
    screenshot: AutomationConfig['evidence']['screenshot'];
    trace: AutomationConfig['evidence']['trace'];
    testIdAttribute: string;
  };
  projects: { name: string; browser: Browser | null; testMatch?: string; dependencies?: string[]; storageState?: string }[];
}

export interface SettingsContext {
  rootDir: string;
  env: NodeJS.ProcessEnv;
  isInstalled: (pkg: string) => boolean;
}

export function playwrightSettings(config: AutomationConfig, ctx: SettingsContext): PlaywrightSettings {
  const runDir = ctx.env.PIPELINE_RUN_DIR;
  const label = ctx.env.PIPELINE_LABEL ?? 'adhoc';
  const reportsDir = runDir ? path.join(runDir, 'reports', label) : path.join(ctx.rootDir, 'playwright-report');
  const outputDir = runDir ? path.join(runDir, 'evidence', label) : path.join(ctx.rootDir, 'test-results');
  const ext = config.language === 'typescript' ? 'ts' : 'js';

  const reporter: ReporterEntry[] = [['list']];
  const missingReporters: string[] = [];
  for (const r of config.reporters) {
    if (r === 'json') reporter.push(['json', { outputFile: path.join(reportsDir, 'results.json') }]);
    else if (r === 'html') reporter.push(['html', { outputFolder: path.join(reportsDir, 'html'), open: 'never' }]);
    else if (r === 'junit') reporter.push(['junit', { outputFile: path.join(reportsDir, 'junit.xml') }]);
    else if (r === 'allure') {
      if (ctx.isInstalled('allure-playwright')) {
        reporter.push(['allure-playwright', { resultsDir: path.join(reportsDir, 'allure-results'), detail: true, suiteTitle: true }]);
      } else missingReporters.push('allure');
    }
  }

  const storageState = config.auth.approach === 'storage-state' ? path.join(ctx.rootDir, AUTH_STATE_FILE) : undefined;
  const projects: PlaywrightSettings['projects'] = [];
  if (storageState) projects.push({ name: 'setup', browser: null, testMatch: `**/*.setup.${ext}` });
  for (const b of config.browsers) {
    projects.push({ name: b, browser: b, ...(storageState ? { dependencies: ['setup'], storageState } : {}) });
  }

  return {
    testDir: path.join(ctx.rootDir, 'tests'),
    testMatch: [`**/*.spec.${ext}`],
    testIgnore: ['**/pipeline/**'], // node:test suites for the pipeline itself
    outputDir,
    reportsDir,
    timeout: config.execution.timeoutMs,
    retries: config.execution.retries,
    workers: config.execution.workers ?? undefined,
    reporter,
    missingReporters,
    use: {
      baseURL: config.app.baseUrl,
      video: config.evidence.video,
      screenshot: config.evidence.screenshot,
      trace: config.evidence.trace,
      testIdAttribute: 'data-testid',
    },
    projects,
  };
}
