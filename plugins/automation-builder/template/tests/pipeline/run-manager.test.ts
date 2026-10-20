import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runDir } from '../../engine/pipeline/artifact-manager.ts';
import {
  HealingLimitError, createRun, generateRunId, listRuns, loadManifest, manifestPath, prepareResume,
  recordHealingAttempt, setRunConfig, setTestCounts, updateStage, validateTestCounts,
} from '../../engine/pipeline/run-manager.ts';
import { fakeClock, tmpRoot, validConfig, writeFile } from './helpers.ts';

test('run ids are well-formed and unique', () => {
  const ids = new Set(Array.from({ length: 50 }, () => generateRunId(new Date('2026-10-19T08:30:12Z'))));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^20261019-083012-[0-9a-f]{6}$/);
});

test('createRun writes a valid manifest with hashed inputs and no config yet', (t) => {
  const root = tmpRoot(t);
  writeFile(root, 'input/test-cases/login.md', '# Login\n');
  writeFile(root, 'input/test-cases/sub/cart.md', '# Cart\n');
  const m = createRun(root, { command: 'playwright-pipeline', inputPaths: ['input/test-cases'], clock: fakeClock() });
  assert.equal(m.status, 'in_progress');
  assert.equal(m.currentStage, 'preflight');
  assert.equal(m.config, null);
  assert.deepEqual(m.inputs.map((i) => i.path), ['input/test-cases/login.md', 'input/test-cases/sub/cart.md']);
  assert.match(m.inputs[0]!.sha256, /^[0-9a-f]{64}$/);
  const loaded = loadManifest(root, m.runId);
  assert.ok(loaded.ok, JSON.stringify(loaded));
  assert.deepEqual(listRuns(root), [m.runId]);
});

test('createRun rejects inputs outside the project', (t) => {
  const root = tmpRoot(t);
  assert.throws(() => createRun(root, { command: 'run-tests', inputPaths: ['../elsewhere'] }), /outside the project/);
});

test('stage updates persist; config attaches only during configuration stage', (t) => {
  const root = tmpRoot(t);
  const clock = fakeClock();
  const { runId } = createRun(root, { command: 'playwright-pipeline', clock });
  assert.throws(() => setRunConfig(root, runId, validConfig()), /only be set while the configuration stage is running/);
  updateStage(root, runId, 'preflight', 'running', { clock });
  let m = updateStage(root, runId, 'preflight', 'completed', { clock });
  assert.ok(m.startedAt);
  updateStage(root, runId, 'configuration', 'running', { clock });
  m = setRunConfig(root, runId, validConfig());
  assert.equal(m.healing.maxAttemptsPerTest, 2);
  m = updateStage(root, runId, 'configuration', 'completed', { clock });
  assert.equal(m.currentStage, 'input_validation');
  assert.equal(m.endedAt, null, 'run still in progress');
});

test('completing configuration without a config makes the manifest invalid', (t) => {
  const root = tmpRoot(t);
  const { runId } = createRun(root, { command: 'run-tests' });
  updateStage(root, runId, 'preflight', 'running');
  updateStage(root, runId, 'preflight', 'completed');
  updateStage(root, runId, 'configuration', 'running');
  updateStage(root, runId, 'configuration', 'completed');
  const r = loadManifest(root, runId);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.issues.some((i) => /config is null/.test(i)));
});

test('artifacts must exist, be non-empty, and stay inside the run dir', (t) => {
  const root = tmpRoot(t);
  const { runId } = createRun(root, { command: 'playwright-pipeline' });
  updateStage(root, runId, 'preflight', 'running');
  assert.throws(
    () => updateStage(root, runId, 'preflight', 'completed', { artifacts: { preflight: 'preflight.json' } }),
    /does not exist/,
  );
  writeFileSync(path.join(runDir(root, runId), 'empty.json'), '');
  assert.throws(() => updateStage(root, runId, 'preflight', 'completed', { artifacts: { e: 'empty.json' } }), /is empty/);
  assert.throws(() => updateStage(root, runId, 'preflight', 'completed', { artifacts: { x: '../x.json' } }), /must be relative/);
  writeFileSync(path.join(runDir(root, runId), 'preflight.json'), '{}');
  const m = updateStage(root, runId, 'preflight', 'completed', { artifacts: { preflight: 'preflight.json' } });
  assert.equal(m.artifacts.preflight, 'preflight.json');
  assert.deepEqual(m.stages.preflight.artifacts, ['preflight.json']);
});

test('illegal transition leaves the manifest unchanged', (t) => {
  const root = tmpRoot(t);
  const { runId } = createRun(root, { command: 'playwright-pipeline' });
  const before = readFileSync(manifestPath(root, runId), 'utf8');
  assert.throws(() => updateStage(root, runId, 'execution', 'running'));
  assert.equal(readFileSync(manifestPath(root, runId), 'utf8'), before);
});

test('atomic writes leave no temp files behind', (t) => {
  const root = tmpRoot(t);
  const { runId } = createRun(root, { command: 'playwright-pipeline' });
  updateStage(root, runId, 'preflight', 'running');
  assert.deepEqual(readdirSync(runDir(root, runId)), ['manifest.json']);
});

test('corrupted or tampered manifests are refused', (t) => {
  const root = tmpRoot(t);
  const { runId } = createRun(root, { command: 'playwright-pipeline' });
  const p = manifestPath(root, runId);

  writeFileSync(p, '{ truncated');
  assert.equal(loadManifest(root, runId).ok, false);

  const m = createRun(root, { command: 'playwright-pipeline' });
  const raw = JSON.parse(readFileSync(manifestPath(root, m.runId), 'utf8'));
  raw.status = 'completed'; // claims success while stages are pending
  writeFileSync(manifestPath(root, m.runId), JSON.stringify(raw));
  const r = loadManifest(root, m.runId);
  assert.ok(!r.ok && r.issues.some((i) => /inconsistent/.test(i)));
});

test('resume recovers an interrupted stage and reports the next stage', (t) => {
  const root = tmpRoot(t);
  const { runId } = createRun(root, { command: 'playwright-pipeline' });
  updateStage(root, runId, 'preflight', 'running'); // process "dies" here
  const r = prepareResume(root, runId);
  assert.ok(r.ok);
  assert.deepEqual(r.recovered, ['preflight']);
  assert.equal(r.manifest.status, 'failed', 'partial run is not reported as success');
  assert.equal(r.next, 'preflight');
  // the failed stage can now be retried
  assert.equal(updateStage(root, runId, 'preflight', 'running').status, 'in_progress');
});

test('cancelled runs cannot be resumed', (t) => {
  const root = tmpRoot(t);
  const { runId } = createRun(root, { command: 'run-tests' });
  updateStage(root, runId, 'preflight', 'cancelled');
  const r = prepareResume(root, runId);
  assert.equal(r.ok, false);
});

test('test counts must be consistent; flaky is never counted as passed', (t) => {
  assert.deepEqual(validateTestCounts({ total: 4, passed: 1, failed: 1, flaky: 1, healed: 1, blocked: 0, skipped: 0, unresolved: 1 }), []);
  assert.ok(validateTestCounts({ total: 4, passed: 2, failed: 1, flaky: 1, healed: 1, blocked: 0, skipped: 0, unresolved: 0 }).length > 0);
  assert.ok(validateTestCounts({ total: 1, passed: 0, failed: 1, flaky: 0, healed: 0, blocked: 0, skipped: 0, unresolved: 2 }).length > 0);
  const root = tmpRoot(t);
  const { runId } = createRun(root, { command: 'run-tests' });
  assert.throws(() => setTestCounts(root, runId, { total: 1, passed: 0, failed: 0, flaky: 0, healed: 0, blocked: 0, skipped: 0, unresolved: 0 }));
});

test('healing is limited per test per run', (t) => {
  const root = tmpRoot(t);
  const { runId } = createRun(root, { command: 'playwright-pipeline', config: validConfig() });
  assert.deepEqual(recordHealingAttempt(root, runId, 'TC-001'), { attempt: 1, remaining: 1 });
  assert.deepEqual(recordHealingAttempt(root, runId, 'TC-001'), { attempt: 2, remaining: 0 });
  assert.throws(() => recordHealingAttempt(root, runId, 'TC-001'), HealingLimitError);
  assert.deepEqual(recordHealingAttempt(root, runId, 'TC-002'), { attempt: 1, remaining: 1 }, 'limit is per test');
});

test('healing limit honours a lower configured cap', (t) => {
  const root = tmpRoot(t);
  const cfg = validConfig();
  cfg.healing.maxAttemptsPerTest = 1;
  const { runId } = createRun(root, { command: 'heal-tests', config: cfg });
  recordHealingAttempt(root, runId, 'TC-001');
  assert.throws(() => recordHealingAttempt(root, runId, 'TC-001'), HealingLimitError);
});

test('listRuns on a fresh project returns empty', (t) => {
  const root = tmpRoot(t);
  assert.deepEqual(listRuns(root), []);
  assert.equal(existsSync(path.join(root, 'output')), false);
});
