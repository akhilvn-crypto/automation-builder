// Maps the validated automation config to Playwright Test options. Pure: no @playwright/test import,
// so it is unit-tested without Playwright installed. playwright.config.ts is a thin wrapper around it.
//
// Output stays inside the framework folders from playwright_framework_structure.md. When the executor sets
// PIPELINE_RUN_ID and PIPELINE_LABEL, reporter output goes to reports/<run-id>/<label>/ and evidence (screenshots,
// video, traces) to test-results/<run-id>/<label>/. A plain `npx playwright test` uses reports/adhoc/ and
// test-results/adhoc/, so it never wipes a pipeline run's evidence (Playwright cleans its outputDir on start).

import path from 'node:path';
import { ADHOC_SCOPE, EVIDENCE_DIR, REPORTS_DIR } from '../pipeline/artifact-manager.ts';
import type { AutomationConfig, Browser } from './schema.ts';

export const AUTH_DIR = 'auth'; // login setup (*.setup.*) and the saved storage state; the state file is git-ignored
export const AUTH_STATE_FILE = `${AUTH_DIR}/storage-state.json`;

export type ReporterEntry = [string] | [string, Record<string, unknown>];

export interface PlaywrightSettings {
  testDir: string;
  testMatch: string[];
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
  projects: { name: string; browser: Browser | null; testDir?: string; testMatch?: string; dependencies?: string[]; storageState?: string }[];
}

export interface SettingsContext {
  rootDir: string;
  env: NodeJS.ProcessEnv;
  isInstalled: (pkg: string) => boolean;
}

export function playwrightSettings(config: AutomationConfig, ctx: SettingsContext): PlaywrightSettings {
  const runId = ctx.env.PIPELINE_RUN_ID;
  const scope = runId ? path.join(runId, ctx.env.PIPELINE_LABEL ?? 'initial') : ADHOC_SCOPE;
  const reportsDir = path.join(ctx.rootDir, REPORTS_DIR, scope);
  const outputDir = path.join(ctx.rootDir, EVIDENCE_DIR, scope);
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
  if (storageState) projects.push({ name: 'setup', browser: null, testDir: path.join(ctx.rootDir, AUTH_DIR), testMatch: `**/*.setup.${ext}` });
  for (const b of config.browsers) {
    projects.push({ name: b, browser: b, ...(storageState ? { dependencies: ['setup'], storageState } : {}) });
  }

  return {
    testDir: path.join(ctx.rootDir, 'tests'),
    testMatch: [`**/*.spec.${ext}`],
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
