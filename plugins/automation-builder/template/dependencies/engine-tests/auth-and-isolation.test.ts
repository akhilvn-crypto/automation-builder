// Priority 5 (authentication and test state) and the worker rules of Priority 6: saved login state is validated before it is
// trusted, expiry is diagnosed and recovered from, secrets never reach logs, and parallel workers get isolation rules.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateConfig, type AutomationConfig } from '../engine/config/schema.ts';
import { cookieHeaderFor, evaluateProbeResponse, probeState, type ProbeRunner } from '../engine/pipeline/auth-probe.ts';
import {
  AUTH_META_FILE, authRejectedTests, clearAuthState, inspectAuthState, runWithAuthState, writeAuthMeta,
} from '../engine/pipeline/auth-state.ts';
import { buildFailureAnalysis } from '../engine/pipeline/failure-classifier.ts';
import { normalizeReport, validateExecutionResults, type ExecutionResults } from '../engine/pipeline/execution.ts';
import { accountPool, resolveExecutionPlan } from '../engine/pipeline/execution-plan.ts';
import { isIgnored } from '../engine/utils/gitignore.ts';
import { redactAll, redactSensitive } from '../engine/utils/redact.ts';
import { pwReport, tmpRoot, validConfig, writeFile } from './helpers.ts';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'cli', 'pipeline.ts');
const NOW = new Date('2026-10-20T12:00:00.000Z');
const STATE = 'auth/storage-state.json';

function storageConfig(over: Partial<AutomationConfig['auth']> = {}, execution: Partial<AutomationConfig['execution']> = {}): AutomationConfig {
  const c = validConfig();
  return { ...c, auth: { approach: 'storage-state', credentialEnvVars: ['TEST_USER_PASSWORD'], ...over }, execution: { ...c.execution, ...execution } };
}

const cookie = (over: Record<string, unknown> = {}) => ({ name: 'sid', value: 'super-secret-session-value', domain: 'test.example.com', path: '/', expires: -1, secure: true, ...over });

function saveState(root: string, cookies: unknown[] = [cookie()], createdHoursAgo: number | null = 1, origin = 'https://test.example.com') {
  writeFile(root, STATE, JSON.stringify({ cookies, origins: [] }));
  if (createdHoursAgo !== null) {
    writeFile(root, AUTH_META_FILE, JSON.stringify({ schemaVersion: 1, createdAt: new Date(NOW.getTime() - createdHoursAgo * 3_600_000).toISOString(), origin, credentialEnvVars: [] }));
  }
}

const inspect = (root: string, config = storageConfig(), probe?: ProbeRunner) =>
  inspectAuthState(root, config, { now: NOW, probe });

// ---- ignore rules and redaction ----

test('the gitignore check proves secrets and saved sessions are excluded, and stays cautious otherwise', (t) => {
  const root = tmpRoot(t);
  assert.equal(isIgnored(root, '.env'), false, 'no .gitignore means not ignored');
  writeFile(root, '.gitignore', '# secrets\n.env\n.env.*\n!.env.example\n.auth/\n**/storage-state*.json\n/dist\n');
  assert.deepEqual(['.env', '.env.local', '.auth/storage-state.json', 'a/b/storage-state-2.json', 'dist/x.js'].map((f) => isIgnored(root, f)), [true, true, true, true, true]);
  assert.deepEqual(['.env.example', 'src/dist/x.js', 'README.md'].map((f) => isIgnored(root, f)), [false, false, false]);
});

test('credential-shaped text is masked even when it is not a configured secret', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-';
  const text = [
    'Authorization: Bearer abc123def456ghi789', 'Cookie: sid=abcdef123456; theme=dark', 'Set-Cookie: session=zzzzzzzz1234; HttpOnly',
    `jwt ${jwt}`, 'GET /api?access_token=tok_1234567890&x=1', '{"api_key": "key_abcdef123456"}', 'password is hunter2-hunter2',
  ].join('\n');
  const out = redactAll(text, ['hunter2-hunter2']);
  for (const leaked of ['abc123def456ghi789', 'sid=abcdef123456', 'zzzzzzzz1234', jwt, 'tok_1234567890', 'key_abcdef123456', 'hunter2']) {
    assert.equal(out.includes(leaked), false, `${leaked} leaked`);
  }
  assert.match(out, /x=1/, 'ordinary text survives');
  assert.equal(redactSensitive('nothing secret here'), 'nothing secret here');
});

// ---- inspecting saved state ----

test('only storage-state auth uses saved state', (t) => {
  const root = tmpRoot(t);
  for (const approach of ['none', 'ui-login'] as const) {
    const r = inspectAuthState(root, { ...validConfig(), auth: { approach, credentialEnvVars: [] } }, { now: NOW });
    assert.deepEqual([r.status, r.decision], ['not_applicable', 'not_applicable']);
  }
});

test('saved state is trusted only when it exists, is well-formed, belongs to this origin and is young and unexpired', (t) => {
  const root = tmpRoot(t);
  const status = (config = storageConfig()) => { const r = inspect(root, config); return [r.status, r.decision]; };

  assert.deepEqual(status(), ['absent', 'refresh']);
  writeFile(root, STATE, '{ not json');
  assert.deepEqual(status(), ['unreadable', 'refresh']);
  writeFile(root, STATE, JSON.stringify({ cookies: [{ name: 1 }], origins: [] }));
  assert.equal(inspect(root).status, 'unreadable', 'malformed cookies');
  writeFile(root, STATE, JSON.stringify({ hello: 'world' }));
  assert.equal(inspect(root).status, 'unreadable', 'not a storage state');

  saveState(root, [cookie()], null);
  assert.deepEqual(status(), ['no_age_record', 'refresh']);
  saveState(root, [cookie()], 1, 'https://other.example.com');
  assert.deepEqual(status(), ['origin_mismatch', 'refresh']);
  saveState(root, [cookie()], 9);
  const old = inspect(root);
  assert.deepEqual([old.status, old.ageHours], ['too_old', 9]);
  assert.deepEqual(status(storageConfig({ state: { maxAgeHours: 12 } })), ['valid', 'reuse'], 'the age limit is configurable');

  const past = NOW.getTime() / 1000 - 60;
  saveState(root, [cookie({ expires: past }), cookie({ name: 'b', expires: past })], 1);
  const expired = inspect(root);
  assert.deepEqual([expired.status, expired.decision, expired.cookies], ['expired', 'refresh', { total: 2, expired: 2, session: 0 }]);

  saveState(root, [cookie({ expires: past }), cookie({ name: 'keep', expires: NOW.getTime() / 1000 + 3600 })], 1);
  const partial = inspect(root);
  assert.deepEqual([partial.status, partial.decision], ['valid', 'reuse']);
  assert.ok(partial.warnings.some((w) => /1 of 2 saved cookies have expired/.test(w)));

  saveState(root, [cookie()], 1);
  const fine = inspect(root);
  assert.deepEqual([fine.status, fine.decision, fine.verifiedByApplication], ['valid', 'reuse', false]);
  assert.ok(fine.warnings.some((w) => /not asked/.test(w)), 'unverified reuse says so');
  assert.equal(JSON.stringify(fine).includes('super-secret-session-value'), false, 'the report never contains cookie values');
});

test('a configured probe decides: accepted state is reused and verified; rejected or unverifiable state is replaced', (t) => {
  const root = tmpRoot(t);
  saveState(root);
  const config = storageConfig({ state: { probePath: '/account' } });
  const seen: string[] = [];
  const probe = (outcome: 'ok' | 'rejected' | 'unreachable' | 'error') => (args: { probePath: string }) => { seen.push(args.probePath); return { outcome, httpStatus: outcome === 'ok' ? 200 : null, detail: `probe said ${outcome}` }; };

  const ok = inspect(root, config, probe('ok'));
  assert.deepEqual([ok.status, ok.decision, ok.verifiedByApplication, ok.probe.outcome], ['valid', 'reuse', true, 'ok']);
  const rejected = inspect(root, config, probe('rejected'));
  assert.deepEqual([rejected.status, rejected.decision], ['rejected_by_app', 'refresh']);
  assert.match(rejected.reason, /no longer accepts the saved session/);
  for (const outcome of ['unreachable', 'error'] as const) {
    assert.deepEqual([inspect(root, config, probe(outcome)).status, inspect(root, config, probe(outcome)).decision], ['unverifiable', 'refresh']);
  }
  assert.ok(seen.every((p) => p === '/account'));
});

// ---- the probe itself ----

test('probe decisions come from the status and redirect target only', () => {
  const e = (status: number, location: string | null, pattern: string | null = null) => evaluateProbeResponse(status, location, '/account', pattern).outcome;
  assert.deepEqual([e(200, null), e(204, null)], ['ok', 'ok']);
  assert.deepEqual([e(401, null), e(403, null)], ['rejected', 'rejected']);
  assert.equal(e(302, '/login'), 'rejected');
  assert.equal(e(302, 'https://x.test/sso', '/sso'), 'rejected');
  assert.equal(e(301, '/account/'), 'ok', 'a redirect to the same path is not a logout');
  assert.equal(e(404, null), 'error');
  assert.equal(e(503, null), 'unreachable');
});

test('cookies are sent the way a browser would: matching host and path, unexpired, Secure only over https', () => {
  const url = new URL('https://app.test.example.com/account');
  const jar = [
    cookie({ name: 'a', domain: '.test.example.com' }), cookie({ name: 'b', domain: 'other.com' }), cookie({ name: 'c', path: '/admin' }),
    cookie({ name: 'd', expires: 100 }), cookie({ name: 'e', expires: 4_000_000_000 }),
  ].map((c) => ({ ...c, domain: c.name === 'a' ? '.test.example.com' : c.name === 'b' ? 'other.com' : 'app.test.example.com' }));
  assert.equal(cookieHeaderFor(url, jar, 1_000_000), 'a=super-secret-session-value; e=super-secret-session-value');
  assert.equal(cookieHeaderFor(new URL('http://app.test.example.com/account'), jar, 1_000_000), '', 'Secure cookies are not sent over http');
});

function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/account') {
      if (req.headers.cookie?.includes('sid=good')) { res.writeHead(200).end('private'); return; }
      res.writeHead(302, { location: '/login' }).end();
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
  }));
}

test('the real probe accepts a live session, rejects a logged-out one and reports an unreachable application', async (t) => {
  const root = tmpRoot(t);
  const app = await startServer();
  t.after(() => app.close());
  const write = (value: string) => writeFile(root, STATE, JSON.stringify({ cookies: [{ name: 'sid', value, domain: '127.0.0.1', path: '/', expires: -1, secure: false }], origins: [] }));
  const args = (baseUrl: string) => ({ baseUrl, probePath: '/account', stateFile: path.join(root, STATE), loggedOutPattern: null });

  write('good');
  assert.equal((await probeState(args(app.url))).outcome, 'ok');
  write('stale');
  const rejected = await probeState(args(app.url));
  assert.deepEqual([rejected.outcome, rejected.httpStatus], ['rejected', 302]);
  await app.close();
  assert.equal((await probeState(args(app.url))).outcome, 'unreachable');
  assert.equal(JSON.stringify(rejected).includes('stale'), false, 'the probe result never carries cookie values');
});

// ---- running with managed state ----

function results(over: Partial<ExecutionResults> = {}): ExecutionResults {
  return { schemaVersion: 1, runId: 'r', label: 'initial', executedAt: 'x', command: [], exitCode: 0, runnerError: null, rawReport: null, runnerLog: '', stats: { total: 1, passed: 1, failed: 0, flaky: 0, skipped: 0 }, tests: [], ...over };
}
const failing = (message: string): ExecutionResults['tests'][number] => ({
  key: 'TC-1@chromium', testId: 'TC-1', title: '[TC-1] x', file: 'tests/generated/a.spec.ts', line: 1, project: 'chromium', outcome: 'failed',
  attempts: [{ retry: 0, status: 'failed', durationMs: 1, errors: [{ message, stack: null, location: null }], attachments: [] }],
});

test('no saved state: the first run logs in and records when; the next run reuses it without logging in', (t) => {
  const root = tmpRoot(t);
  const config = storageConfig();
  const calls: (string | undefined)[] = [];
  const run = () => runWithAuthState(root, config, {
    now: NOW,
    runOnce: (env) => {
      calls.push(env.PIPELINE_AUTH_STATE);
      if (env.PIPELINE_AUTH_STATE === 'refresh') saveState(root, [cookie()], null); // what the setup project does
      return results({ authSetup: env.PIPELINE_AUTH_STATE === 'refresh' ? { outcome: 'passed', error: null } : undefined });
    },
  });

  const first = run();
  assert.deepEqual([first.authState?.decision, first.authState?.setup, first.authState?.status], ['refresh', 'passed', 'absent']);
  assert.ok(existsSync(path.join(root, AUTH_META_FILE)), 'creation time recorded');
  const second = run();
  assert.deepEqual([second.authState?.decision, second.authState?.reason.includes('1h') || second.authState?.reason.includes('0h')], ['reuse', true]);
  assert.deepEqual(calls, ['refresh', 'reuse'], 'the second run did not log in');
  assert.equal(second.authState?.verifiedByApplication, false);
});

test('state rejected during a run is diagnosed, discarded and the tests are run again once with a fresh login', (t) => {
  const root = tmpRoot(t);
  const config = storageConfig();
  saveState(root, [cookie()], 1);
  const calls: { env: string | undefined; stateExistedAtStart: boolean }[] = [];
  const out = runWithAuthState(root, config, {
    now: NOW,
    runOnce: (env) => {
      calls.push({ env: env.PIPELINE_AUTH_STATE, stateExistedAtStart: existsSync(path.join(root, STATE)) });
      if (env.PIPELINE_AUTH_STATE === 'reuse') return results({ tests: [failing('page.goto: redirected to https://test.example.com/login')], stats: { total: 1, passed: 0, failed: 1, flaky: 0, skipped: 0 } });
      saveState(root, [cookie()], null);
      return results({ authSetup: { outcome: 'passed', error: null } });
    },
  });
  assert.deepEqual(calls, [{ env: 'reuse', stateExistedAtStart: true }, { env: 'refresh', stateExistedAtStart: false }], 'the rejected state is removed before logging in again');
  assert.equal(out.authState?.recovered, true);
  assert.match(out.authState?.diagnosis ?? '', /saved authentication state was rejected during the run \(1 test\(s\) failed as logged out: TC-1\)/);
  assert.equal(out.stats.failed, 0, 'the final results are those of the fresh login');
  assert.ok(existsSync(path.join(root, AUTH_META_FILE)));
});

test('a login that fails is a runner problem, not a pile of test failures; a configured pattern recognises logged-out symptoms', (t) => {
  const root = tmpRoot(t);
  const report = pwReport(root, [
    { title: 'authenticate', file: 'auth.setup.ts', project: 'setup', status: 'unexpected', results: [{ status: 'failed', error: 'locator.fill: Timeout exceeded' }] },
    { title: '[TC-1] needs login', file: 'generated/a.spec.ts', status: 'skipped', results: [{ status: 'skipped' }] },
  ]);
  const normalized = normalizeReport(report, { rootDir: root, runId: 'r', label: 'initial', secrets: [], now: NOW });
  assert.equal(normalized.tests.length, 1, 'the setup step is not a test');
  assert.deepEqual(normalized.authSetup?.outcome, 'failed');
  assert.match(normalized.runnerError ?? '', /^authentication setup failed: locator.fill/);
  assert.ok(validateExecutionResults(normalized).some((i) => /authentication setup failed/.test(i)), 'the execution stage cannot complete');

  const config = storageConfig({ state: { loggedOutPattern: 'Please sign in' } });
  const hit = authRejectedTests(results({ tests: [failing('Expected heading, saw: Please sign in to continue')] }), config);
  const miss = authRejectedTests(results({ tests: [failing('Expected "Home" received "Welcome"')] }), config);
  assert.deepEqual([hit.length, miss.length], [1, 0]);
});

test('logged out despite a fresh login is classified as an account problem and never offered for repair', () => {
  const rejected = failing('Error: net::ERR_ABORTED; Unauthorized (401)');
  const fresh = buildFailureAnalysis(results({ tests: [rejected], authState: { decision: 'refresh', status: 'absent', reason: 'x', verifiedByApplication: false, recovered: false, setup: 'passed', diagnosis: null, warnings: [] } }));
  assert.deepEqual([fresh.failures[0]!.category, fresh.failures[0]!.healingEligible], ['test_data_or_precondition', false]);
  assert.match(fresh.failures[0]!.signals[0]!, /logged out despite a fresh login/);
});

test('clearing saved state is explicit and reports exactly what was removed', (t) => {
  const root = tmpRoot(t);
  assert.deepEqual(clearAuthState(root), []);
  saveState(root);
  writeAuthMeta(root, storageConfig(), NOW);
  assert.deepEqual(clearAuthState(root), [STATE, AUTH_META_FILE]);
  assert.equal(inspect(root).status, 'absent');
});

// ---- configuration rules ----

test('auth state and isolation settings are validated', () => {
  const ok = (c: unknown) => validateConfig(c).ok;
  assert.equal(ok(storageConfig({ state: { maxAgeHours: 4, probePath: '/account', loggedOutPattern: 'login|sign-?in' } })), true);
  assert.equal(ok({ ...validConfig(), auth: { approach: 'ui-login', credentialEnvVars: [], state: { maxAgeHours: 4 } } }), false, 'state settings need storage-state');
  for (const state of [{ probePath: 'account' }, { probePath: '//evil.example/x' }, { probePath: 'https://evil.example/' }, { maxAgeHours: 0 }, { loggedOutPattern: '(' }, { token: 'x' }]) {
    assert.equal(ok(storageConfig({ state })), false, JSON.stringify(state));
  }
  assert.equal(ok(storageConfig({}, { isolation: 'shared-readonly' })), true);
  assert.equal(ok(storageConfig({}, { isolation: 'sometimes' as never })), false);
  assert.equal(ok(storageConfig({}, { isolation: 'per-worker-accounts' })), false, 'one shared session cannot serve per-worker accounts');
  const c = validConfig();
  assert.equal(ok({ ...c, execution: { ...c.execution, isolation: 'per-worker-accounts' } }), false, 'needs credential variables');
  assert.equal(ok({ ...c, auth: { approach: 'ui-login', credentialEnvVars: ['TEST_USER_PASSWORD'] }, execution: { ...c.execution, isolation: 'per-worker-accounts' } }), true);
});

// ---- worker plan ----

test('workers default to a conservative number, never to the CPU-based Playwright default', () => {
  const c = validConfig();
  const plan = (config: AutomationConfig, env: NodeJS.ProcessEnv = {}, cpus = 16) => resolveExecutionPlan(config, env, cpus);
  assert.deepEqual([plan(c).workers, plan(c).workersSource, plan(c).fullyParallel], [2, 'default', false]);
  assert.equal(plan(c, {}, 1).workers, 1, 'never more than the machine has by default');
  assert.deepEqual([plan({ ...c, execution: { ...c.execution, workers: 6 } }).workers, plan({ ...c, execution: { ...c.execution, workers: 6 } }).workersSource], [6, 'config']);
  assert.match(plan({ ...c, execution: { ...c.execution, workers: 12 } }, {}, 4).warnings[0]!, /12 workers requested on a machine with 4 CPUs/);
});

test('isolation rules cap workers and say why', () => {
  const c = storageConfig();
  const exec = (over: Partial<AutomationConfig['execution']>, auth: Partial<AutomationConfig['auth']> = {}): AutomationConfig => ({ ...c, auth: { ...c.auth, ...auth }, execution: { ...c.execution, ...over } });

  const serial = resolveExecutionPlan(exec({ workers: 4, isolation: 'serial' }), {}, 8);
  assert.deepEqual([serial.workers, serial.fullyParallel, serial.limits.length], [1, false, 1]);

  const shared = resolveExecutionPlan(exec({ workers: 4, isolation: 'shared-readonly' }), {}, 8);
  assert.deepEqual([shared.workers, shared.fullyParallel, shared.limits], [4, true, []]);

  const unspecified = resolveExecutionPlan(exec({ workers: 4 }), {}, 8);
  assert.equal(unspecified.workers, 4);
  assert.match(unspecified.warnings.join(), /several workers share one account/);
  assert.equal(resolveExecutionPlan(exec({ workers: 4 }, { approach: 'none' }), {}, 8).warnings.length, 0);

  const perWorker = (env: NodeJS.ProcessEnv) => resolveExecutionPlan(exec({ workers: 6, isolation: 'per-worker-accounts' }, { approach: 'ui-login' }), env, 8);
  const three = perWorker({ TEST_USER_PASSWORD_1: 'a', TEST_USER_PASSWORD_2: 'b', TEST_USER_PASSWORD_3: 'c' });
  assert.deepEqual([three.workers, three.accountPool, three.fullyParallel], [3, [{ envVar: 'TEST_USER_PASSWORD', size: 3 }], true]);
  assert.match(three.limits[0]!, /only 3 account\(s\) defined/);
  const none = perWorker({});
  assert.deepEqual([none.workers], [1]);
  assert.match(none.limits[0]!, /no per-worker credentials were found \(TEST_USER_PASSWORD_1\)/);
  assert.equal(JSON.stringify(three).includes('"a"'), false, 'the plan holds counts, never values');
  assert.deepEqual(accountPool(['X', 'Y'], { X_1: 'a', X_2: 'b', Y_1: 'c', Y_3: 'gap' }), [{ envVar: 'X', size: 2 }, { envVar: 'Y', size: 1 }], 'pools must be consecutive');
});

// ---- CLI ----

test('CLI: auth check explains the decision without printing secrets, and auth clear removes the session', (t) => {
  const root = tmpRoot(t);
  writeFile(root, 'cfg.json', JSON.stringify(storageConfig()));
  writeFile(root, '.gitignore', 'auth/\n');
  spawnSync(process.execPath, [CLI, 'config', 'save', '--file', path.join(root, 'cfg.json'), '--root', root]);
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8' });

  const absent = JSON.parse(run('auth', 'check').stdout);
  assert.deepEqual([absent.status, absent.decision, absent.gitignored.state, absent.gitignored.env], ['absent', 'refresh', true, false]);

  mkdirSync(path.join(root, 'auth'), { recursive: true });
  writeFileSync(path.join(root, STATE), JSON.stringify({ cookies: [cookie({ value: 'cli-secret-cookie' })], origins: [] }));
  const check = run('auth', 'check');
  assert.equal(check.stdout.includes('cli-secret-cookie'), false);
  assert.equal(JSON.parse(check.stdout).status, 'no_age_record');
  assert.deepEqual(JSON.parse(run('auth', 'clear').stdout).removed, [STATE]);
  assert.equal(existsSync(path.join(root, STATE)), false);
  assert.equal(readFileSync(path.join(root, '.gitignore'), 'utf8'), 'auth/\n');
});
