import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AutomationConfig } from '../../src/config/schema.ts';

export function tmpRoot(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pw-pipeline-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function validConfig(): AutomationConfig {
  return {
    schemaVersion: 1,
    language: 'typescript',
    packageManager: 'npm',
    app: { baseUrl: 'https://test.example.com', environment: 'qa' },
    input: { testCasesPath: 'input/test-cases' },
    browsers: ['chromium'],
    evidence: { video: 'retain-on-failure', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
    reporters: ['html', 'json'],
    auth: { approach: 'none', credentialEnvVars: [] },
    exploration: { tool: 'playwright-cli' },
    execution: { workers: null, retries: 1, timeoutMs: 30_000 },
    healing: { maxAttemptsPerTest: 2 },
    retention: { keepRuns: null },
  };
}

export function writeFile(root: string, rel: string, content: string): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

// Realistic Playwright error messages for classifier/healing tests.
export const ERRORS = {
  notFound: "Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('button', { name: 'Sign in' })\nExpected: visible\nReceived: <element(s) not found>\nTimeout: 5000ms\n\nCall log:\n  - waiting for getByRole('button', { name: 'Sign in' })",
  mismatch: "Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByRole('heading', { level: 1 })\nExpected string: \"Dashboard\"\nReceived string: \"Something went wrong\"\n\nCall log:\n  - waiting for getByRole('heading', { level: 1 })\n    9 × locator resolved to <h1>Something went wrong</h1>",
  network: 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4173/',
  strict: "Error: locator.click: Error: strict mode violation: getByRole('button') resolved to 3 elements",
  missingEnv: 'MissingEnvError: Missing required environment variable TEST_USER_PASSWORD. Set it in .env',
} as const;

export interface FakeTest {
  title: string;
  file: string; // relative to tests/
  line?: number;
  project?: string;
  status: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  results: { status: string; error?: string; attachments?: { name: string; contentType: string; path: string }[] }[];
}

// Shape of Playwright's JSON reporter output (only the fields the pipeline reads).
export function pwReport(root: string, tests: FakeTest[], errors: string[] = []): unknown {
  const byFile = new Map<string, FakeTest[]>();
  for (const t of tests) byFile.set(t.file, [...(byFile.get(t.file) ?? []), t]);
  return {
    config: { rootDir: path.join(root, 'tests') },
    suites: [...byFile].map(([file, ts]) => ({
      title: file, file,
      specs: ts.map((t) => ({
        title: t.title, file, line: t.line ?? 3,
        tests: [{
          projectName: t.project ?? 'chromium', annotations: [], expectedStatus: 'passed', status: t.status,
          results: t.results.map((r, i) => ({
            retry: i, status: r.status, duration: 10,
            errors: r.error ? [{ message: r.error, stack: r.error }] : [],
            attachments: r.attachments ?? [],
          })),
        }],
      })),
    })),
    errors: errors.map((message) => ({ message })),
    stats: {},
  };
}

// Deterministic clock: each call advances one second.
export function fakeClock(start = '2026-10-19T08:00:00.000Z'): () => Date {
  let t = Date.parse(start);
  return () => new Date((t += 1000));
}
