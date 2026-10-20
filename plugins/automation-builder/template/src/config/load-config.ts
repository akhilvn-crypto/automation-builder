// Resolves the effective configuration.
//
// Precedence (lowest -> highest):
//   1. DEFAULTS (non-material settings only)
//   2. config/automation.config.json (approved, persisted choices)
//   3. environment variables (see ENV_OVERRIDES)
//   4. explicit command arguments
//
// Objects merge key-by-key; arrays and scalars are replaced wholesale.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../utils/fs.ts';
import { DEFAULTS, validateConfig, type AutomationConfig, type ConfigIssue } from './schema.ts';

export const CONFIG_RELATIVE_PATH = 'config/automation.config.json';

type Json = Record<string, unknown>;

// Environment variable -> config path. Values are parsed per `parse`.
export const ENV_OVERRIDES: ReadonlyArray<{ env: string; path: string; parse: (v: string) => unknown }> = [
  { env: 'PW_BASE_URL', path: 'app.baseUrl', parse: (v) => v },
  { env: 'PW_ENVIRONMENT', path: 'app.environment', parse: (v) => v },
  { env: 'PW_BROWSERS', path: 'browsers', parse: (v) => v.split(',').map((s) => s.trim()).filter(Boolean) },
  { env: 'PW_WORKERS', path: 'execution.workers', parse: parseIntOrRaw },
  { env: 'PW_RETRIES', path: 'execution.retries', parse: parseIntOrRaw },
];

// Keep invalid numeric input as-is so validation reports it rather than silently dropping it.
function parseIntOrRaw(v: string): unknown {
  return /^-?\d+$/.test(v.trim()) ? Number(v) : v;
}

export function configPath(rootDir: string): string {
  return path.join(rootDir, CONFIG_RELATIVE_PATH);
}

export type ConfigState =
  | { status: 'valid'; config: AutomationConfig; sources: string[] }
  | { status: 'absent'; issues: ConfigIssue[]; sources: string[] }
  | { status: 'invalid'; issues: ConfigIssue[]; sources: string[] };

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  overrides?: Json; // explicit command arguments, already shaped like the config
}

export function loadConfig(rootDir: string, opts: LoadOptions = {}): ConfigState {
  const env = opts.env ?? process.env;
  const sources = ['defaults'];
  const file = readJson(configPath(rootDir));
  if (!file.ok && file.reason === 'parse_error') {
    return { status: 'invalid', issues: [{ path: '', kind: 'invalid', message: file.message }], sources };
  }
  let merged: Json = structuredClone(DEFAULTS) as unknown as Json;
  if (file.ok) {
    if (!isPlainObject(file.value)) {
      return { status: 'invalid', issues: [{ path: '', kind: 'invalid', message: 'config file must contain a JSON object' }], sources };
    }
    merged = deepMerge(merged, file.value);
    sources.push(CONFIG_RELATIVE_PATH);
  }
  for (const o of ENV_OVERRIDES) {
    const raw = env[o.env];
    if (raw !== undefined && raw !== '') {
      setPath(merged, o.path, o.parse(raw));
      sources.push(`env:${o.env}`);
    }
  }
  if (opts.overrides && Object.keys(opts.overrides).length > 0) {
    merged = deepMerge(merged, opts.overrides);
    sources.push('arguments');
  }
  const result = validateConfig(merged);
  if (result.ok) return { status: 'valid', config: result.config, sources };
  return { status: file.ok ? 'invalid' : 'absent', issues: result.issues, sources };
}

// Persist approved choices. Validates the full config first; never writes an invalid file.
export function saveConfig(rootDir: string, candidate: unknown): { ok: true } | { ok: false; issues: ConfigIssue[] } {
  const merged = isPlainObject(candidate) ? deepMerge(structuredClone(DEFAULTS) as unknown as Json, candidate) : candidate;
  const result = validateConfig(merged);
  if (!result.ok) return { ok: false, issues: result.issues };
  const target = configPath(rootDir);
  mkdirSync(path.dirname(target), { recursive: true });
  writeJsonAtomic(target, result.config);
  return { ok: true };
}

function isPlainObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepMerge(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isPlainObject(b) && isPlainObject(v) ? deepMerge(b, v) : v;
  }
  return out;
}

function setPath(obj: Json, dotted: string, value: unknown): void {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k] as Json;
  }
  cur[keys[keys.length - 1]!] = value;
}
