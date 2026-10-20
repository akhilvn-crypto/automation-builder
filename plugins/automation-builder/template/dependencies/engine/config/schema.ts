// Typed schema and validator for config/automation.config.json.
// The config holds approved, NON-SECRET choices only. Unknown keys are rejected,
// which also prevents secrets from being smuggled into the committed file.

export const CONFIG_SCHEMA_VERSION = 1;

export const LANGUAGES = ['typescript', 'javascript'] as const;
export const BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
// Values map 1:1 to Playwright Test `use.video`, `use.screenshot`, `use.trace` modes.
export const VIDEO_MODES = ['off', 'on', 'retain-on-failure'] as const;
export const SCREENSHOT_MODES = ['off', 'on', 'only-on-failure'] as const;
export const TRACE_MODES = ['off', 'on', 'on-first-retry', 'retain-on-failure'] as const;
export const REPORTERS = ['html', 'json', 'allure', 'junit'] as const;
export const AUTH_APPROACHES = ['none', 'ui-login', 'storage-state'] as const;
export const EXPLORATION_TOOLS = ['playwright-cli', 'none'] as const;

export const MAX_HEALING_ATTEMPTS_CAP = 2;

export type Language = (typeof LANGUAGES)[number];
export type Browser = (typeof BROWSERS)[number];
export type VideoMode = (typeof VIDEO_MODES)[number];
export type ScreenshotMode = (typeof SCREENSHOT_MODES)[number];
export type TraceMode = (typeof TRACE_MODES)[number];
export type Reporter = (typeof REPORTERS)[number];
export type AuthApproach = (typeof AUTH_APPROACHES)[number];
export type ExplorationTool = (typeof EXPLORATION_TOOLS)[number];

export interface AutomationConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  language: Language;
  packageManager: 'npm';
  app: {
    baseUrl: string;
    environment: string;
  };
  input: {
    testCasesPath: string;
  };
  browsers: Browser[];
  evidence: {
    video: VideoMode;
    screenshot: ScreenshotMode;
    trace: TraceMode;
  };
  reporters: Reporter[];
  auth: {
    approach: AuthApproach;
    // Names of environment variables holding credentials. Never the values.
    credentialEnvVars: string[];
  };
  exploration: {
    tool: ExplorationTool;
  };
  execution: {
    workers: number | null; // null = Playwright default
    retries: number;
    timeoutMs: number;
  };
  healing: {
    maxAttemptsPerTest: number;
  };
  retention: {
    keepRuns: number | null; // null = keep all runs
  };
}

// Recommendations offered during setup. These are NOT silently applied for material choices.
export const RECOMMENDED = {
  language: 'typescript',
  evidence: { video: 'retain-on-failure', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  reporters: ['html', 'json', 'allure'],
} as const satisfies Partial<Record<keyof AutomationConfig, unknown>>;

// Defaults for non-material settings. Applied beneath the config file in precedence.
export const DEFAULTS = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  packageManager: 'npm',
  browsers: ['chromium'],
  auth: { approach: 'none', credentialEnvVars: [] },
  exploration: { tool: 'playwright-cli' },
  execution: { workers: null, retries: 1, timeoutMs: 30_000 },
  healing: { maxAttemptsPerTest: MAX_HEALING_ATTEMPTS_CAP },
  retention: { keepRuns: null },
} as const;

export interface ConfigIssue {
  path: string;
  kind: 'missing' | 'invalid';
  message: string;
}

export type ValidationResult =
  | { ok: true; config: AutomationConfig; issues: [] }
  | { ok: false; issues: ConfigIssue[] };

const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]*$/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class Checker {
  issues: ConfigIssue[] = [];

  missing(path: string, message: string): void {
    this.issues.push({ path, kind: 'missing', message });
  }

  invalid(path: string, message: string): void {
    this.issues.push({ path, kind: 'invalid', message });
  }

  object(parent: Obj, key: string, path: string, allowed: readonly string[]): Obj | undefined {
    const v = parent[key];
    if (v === undefined) {
      this.missing(path, `${path} is required`);
      return undefined;
    }
    if (!isObj(v)) {
      this.invalid(path, `${path} must be an object`);
      return undefined;
    }
    this.unknownKeys(v, path, allowed);
    return v;
  }

  unknownKeys(v: Obj, path: string, allowed: readonly string[]): void {
    for (const k of Object.keys(v)) {
      if (!allowed.includes(k)) this.invalid(path ? `${path}.${k}` : k, `unknown key "${k}"`);
    }
  }

  oneOf<T extends string>(parent: Obj, key: string, path: string, values: readonly T[]): void {
    const v = parent[key];
    if (v === undefined) return this.missing(path, `${path} is required (one of: ${values.join(', ')})`);
    if (typeof v !== 'string' || !values.includes(v as T)) {
      this.invalid(path, `${path} must be one of: ${values.join(', ')} (got ${JSON.stringify(v)})`);
    }
  }

  nonEmptyString(parent: Obj, key: string, path: string): void {
    const v = parent[key];
    if (v === undefined) return this.missing(path, `${path} is required`);
    if (typeof v !== 'string' || v.trim() === '') this.invalid(path, `${path} must be a non-empty string`);
  }

  int(parent: Obj, key: string, path: string, min: number, max: number, nullable = false): void {
    const v = parent[key];
    if (v === undefined) return this.missing(path, `${path} is required`);
    if (v === null && nullable) return;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      this.invalid(path, `${path} must be an integer between ${min} and ${max}${nullable ? ' or null' : ''}`);
    }
  }

  setOf<T extends string>(parent: Obj, key: string, path: string, values: readonly T[], minItems: number): void {
    const v = parent[key];
    if (v === undefined) return this.missing(path, `${path} is required (subset of: ${values.join(', ')})`);
    if (!Array.isArray(v) || v.length < minItems) {
      return this.invalid(path, `${path} must be an array with at least ${minItems} item(s)`);
    }
    const seen = new Set<unknown>();
    for (const item of v) {
      if (typeof item !== 'string' || !values.includes(item as T)) {
        this.invalid(path, `${path} contains unsupported value ${JSON.stringify(item)} (allowed: ${values.join(', ')})`);
      } else if (seen.has(item)) {
        this.invalid(path, `${path} contains duplicate value "${item}"`);
      }
      seen.add(item);
    }
  }
}

const TOP_KEYS = [
  'schemaVersion', 'language', 'packageManager', 'app', 'input', 'browsers', 'evidence',
  'reporters', 'auth', 'exploration', 'execution', 'healing', 'retention',
] as const;

export function validateConfig(raw: unknown): ValidationResult {
  const c = new Checker();
  if (!isObj(raw)) {
    return { ok: false, issues: [{ path: '', kind: 'invalid', message: 'config must be a JSON object' }] };
  }
  c.unknownKeys(raw, '', TOP_KEYS);

  if (raw.schemaVersion === undefined) c.missing('schemaVersion', 'schemaVersion is required');
  else if (raw.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    c.invalid('schemaVersion', `unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)} (expected ${CONFIG_SCHEMA_VERSION})`);
  }
  c.oneOf(raw, 'language', 'language', LANGUAGES);
  c.oneOf(raw, 'packageManager', 'packageManager', ['npm'] as const);

  const app = c.object(raw, 'app', 'app', ['baseUrl', 'environment']);
  if (app) {
    if (app.baseUrl === undefined) c.missing('app.baseUrl', 'app.baseUrl is required');
    else if (!isHttpUrl(app.baseUrl)) c.invalid('app.baseUrl', 'app.baseUrl must be an absolute http(s) URL');
    else if (hasUrlCredentials(app.baseUrl)) c.invalid('app.baseUrl', 'app.baseUrl must not embed credentials');
    c.nonEmptyString(app, 'environment', 'app.environment');
  }

  const input = c.object(raw, 'input', 'input', ['testCasesPath']);
  if (input) {
    c.nonEmptyString(input, 'testCasesPath', 'input.testCasesPath');
    if (typeof input.testCasesPath === 'string' && isAbsoluteOrEscaping(input.testCasesPath)) {
      c.invalid('input.testCasesPath', 'input.testCasesPath must be a relative path inside dependencies/ (e.g. input/test-cases)');
    }
  }

  c.setOf(raw, 'browsers', 'browsers', BROWSERS, 1);

  const evidence = c.object(raw, 'evidence', 'evidence', ['video', 'screenshot', 'trace']);
  if (evidence) {
    c.oneOf(evidence, 'video', 'evidence.video', VIDEO_MODES);
    c.oneOf(evidence, 'screenshot', 'evidence.screenshot', SCREENSHOT_MODES);
    c.oneOf(evidence, 'trace', 'evidence.trace', TRACE_MODES);
  }

  c.setOf(raw, 'reporters', 'reporters', REPORTERS, 1);
  if (Array.isArray(raw.reporters) && !raw.reporters.includes('json')) {
    c.invalid('reporters', 'reporters must include "json": the pipeline reads raw JSON results');
  }

  const auth = c.object(raw, 'auth', 'auth', ['approach', 'credentialEnvVars']);
  if (auth) {
    c.oneOf(auth, 'approach', 'auth.approach', AUTH_APPROACHES);
    const vars = auth.credentialEnvVars;
    if (vars === undefined) c.missing('auth.credentialEnvVars', 'auth.credentialEnvVars is required (may be empty)');
    else if (!Array.isArray(vars) || vars.some((n) => typeof n !== 'string' || !ENV_VAR_NAME.test(n))) {
      c.invalid('auth.credentialEnvVars', 'auth.credentialEnvVars must list environment variable NAMES (e.g. TEST_USER_PASSWORD), never values');
    }
  }

  const exploration = c.object(raw, 'exploration', 'exploration', ['tool']);
  if (exploration) c.oneOf(exploration, 'tool', 'exploration.tool', EXPLORATION_TOOLS);

  const execution = c.object(raw, 'execution', 'execution', ['workers', 'retries', 'timeoutMs']);
  if (execution) {
    c.int(execution, 'workers', 'execution.workers', 1, 64, true);
    c.int(execution, 'retries', 'execution.retries', 0, 5);
    c.int(execution, 'timeoutMs', 'execution.timeoutMs', 1_000, 600_000);
  }

  const healing = c.object(raw, 'healing', 'healing', ['maxAttemptsPerTest']);
  if (healing) c.int(healing, 'maxAttemptsPerTest', 'healing.maxAttemptsPerTest', 0, MAX_HEALING_ATTEMPTS_CAP);

  const retention = c.object(raw, 'retention', 'retention', ['keepRuns']);
  if (retention) c.int(retention, 'keepRuns', 'retention.keepRuns', 1, 10_000, true);

  if (c.issues.length > 0) return { ok: false, issues: c.issues };
  return { ok: true, config: raw as unknown as AutomationConfig, issues: [] };
}

function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function hasUrlCredentials(v: string): boolean {
  const u = new URL(v);
  return u.username !== '' || u.password !== '';
}

export function isAbsoluteOrEscaping(p: string): boolean {
  const norm = p.replace(/\\/g, '/');
  return norm.startsWith('/') || /^[a-zA-Z]:/.test(norm) || norm.split('/').includes('..');
}
