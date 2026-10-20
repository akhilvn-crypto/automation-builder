import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { configPath, loadConfig, saveConfig } from '../../src/config/load-config.ts';
import { validateConfig } from '../../src/config/schema.ts';
import { tmpRoot, validConfig, writeFile } from './helpers.ts';

test('valid config passes validation', () => {
  const r = validateConfig(validConfig());
  assert.equal(r.ok, true);
});

test('missing material choices are reported as "missing", not invented', () => {
  const { language, evidence, ...rest } = validConfig();
  const r = validateConfig({ ...rest, app: { environment: 'qa' } });
  assert.equal(r.ok, false);
  const missing = r.issues.filter((i) => i.kind === 'missing').map((i) => i.path).sort();
  assert.deepEqual(missing, ['app.baseUrl', 'evidence', 'language']);
});

test('invalid values are reported with paths', () => {
  const c = validConfig() as unknown as Record<string, any>;
  c.language = 'python';
  c.evidence.trace = 'sometimes';
  c.app.baseUrl = 'ftp://x';
  c.browsers = ['chromium', 'chromium'];
  c.healing.maxAttemptsPerTest = 3;
  const r = validateConfig(c);
  assert.equal(r.ok, false);
  const paths = r.issues.map((i) => i.path).sort();
  assert.deepEqual(paths, ['app.baseUrl', 'browsers', 'evidence.trace', 'healing.maxAttemptsPerTest', 'language']);
  assert.ok(r.issues.every((i) => i.kind === 'invalid'));
});

test('unknown keys are rejected so secrets cannot be persisted', () => {
  const c = { ...validConfig(), password: 'hunter2' };
  const r = validateConfig(c);
  assert.equal(r.ok, false);
  assert.equal(r.issues[0]?.path, 'password');
});

test('credentials embedded in baseUrl are rejected', () => {
  const c = validConfig();
  c.app.baseUrl = 'https://user:pass@test.example.com';
  assert.equal(validateConfig(c).ok, false);
});

test('credentialEnvVars must be variable names, not values', () => {
  const c = validConfig();
  c.auth.credentialEnvVars = ['TEST_USER_PASSWORD'];
  assert.equal(validateConfig(c).ok, true);
  c.auth.credentialEnvVars = ['s3cret value!'];
  assert.equal(validateConfig(c).ok, false);
});

test('json reporter is mandatory for pipeline state', () => {
  const c = validConfig();
  c.reporters = ['html'];
  const r = validateConfig(c);
  assert.equal(r.ok, false);
  assert.match(r.issues[0]!.message, /must include "json"/);
});

test('input path must stay inside the project', () => {
  for (const bad of ['../outside', 'C:\\abs\\path', '/etc/x']) {
    const c = validConfig();
    c.input.testCasesPath = bad;
    assert.equal(validateConfig(c).ok, false, bad);
  }
});

test('absent config file -> status "absent" with missing issues', (t) => {
  const root = tmpRoot(t);
  const s = loadConfig(root, { env: {} });
  assert.equal(s.status, 'absent');
  assert.ok('issues' in s && s.issues.some((i) => i.path === 'language' && i.kind === 'missing'));
});

test('malformed JSON file -> status "invalid"', (t) => {
  const root = tmpRoot(t);
  writeFile(root, 'config/automation.config.json', '{ not json');
  assert.equal(loadConfig(root, { env: {} }).status, 'invalid');
});

test('saveConfig persists only valid config and fills non-material defaults', (t) => {
  const root = tmpRoot(t);
  const { execution, healing, retention, ...partial } = validConfig();
  assert.deepEqual(saveConfig(root, partial), { ok: true });
  const saved = JSON.parse(readFileSync(configPath(root), 'utf8'));
  assert.equal(saved.healing.maxAttemptsPerTest, 2);
  assert.equal(saved.execution.retries, 1);

  const bad = saveConfig(root, { ...partial, language: 'cobol' });
  assert.equal(bad.ok, false);
  // previous valid file untouched
  assert.equal(JSON.parse(readFileSync(configPath(root), 'utf8')).language, 'typescript');
});

test('precedence: defaults < file < env < arguments', (t) => {
  const root = tmpRoot(t);
  saveConfig(root, validConfig());

  const fileOnly = loadConfig(root, { env: {} });
  assert.equal(fileOnly.status, 'valid');
  assert.equal(fileOnly.status === 'valid' && fileOnly.config.app.baseUrl, 'https://test.example.com');

  const withEnv = loadConfig(root, { env: { PW_BASE_URL: 'https://env.example.com', PW_RETRIES: '3' } });
  assert.ok(withEnv.status === 'valid');
  assert.equal(withEnv.config.app.baseUrl, 'https://env.example.com');
  assert.equal(withEnv.config.execution.retries, 3);
  assert.equal(withEnv.config.app.environment, 'qa', 'sibling keys survive a deep merge');
  assert.deepEqual(withEnv.sources, ['defaults', 'config/automation.config.json', 'env:PW_BASE_URL', 'env:PW_RETRIES']);

  const withArgs = loadConfig(root, {
    env: { PW_BASE_URL: 'https://env.example.com' },
    overrides: { app: { baseUrl: 'https://arg.example.com' } },
  });
  assert.ok(withArgs.status === 'valid');
  assert.equal(withArgs.config.app.baseUrl, 'https://arg.example.com');
});

test('invalid env override is surfaced, not ignored', (t) => {
  const root = tmpRoot(t);
  saveConfig(root, validConfig());
  const s = loadConfig(root, { env: { PW_WORKERS: 'many' } });
  assert.equal(s.status, 'invalid');
  assert.ok('issues' in s && s.issues.some((i) => i.path === 'execution.workers'));
});
