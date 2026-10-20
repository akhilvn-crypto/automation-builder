// Layout contract of scripts/init.mjs. Run from the repository root: node --test plugins/automation-builder/tests/init.test.mjs
//
// automation/ must contain only the framework (playwright_framework_structure.md); everything else belongs in
// dependencies/. A project scaffolded by 0.2.x (everything inside automation/) must migrate to that layout.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const INIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'init.mjs');

// Everything the framework structure (or the framework's own tooling) allows at the top of automation/.
const ALLOWED_IN_AUTOMATION = new Set([
  'pages', 'tests', 'helpers', 'fixtures', 'test-data', 'config', 'auth', 'reports', 'test-results',
  'playwright.config.ts', 'playwright.config.js', 'package.json', 'package-lock.json', 'node_modules',
  'tsconfig.json', 'jsconfig.json', '.gitignore', '.env', '.env.example', 'README.md',
]);
// What the scaffolder itself may create up front (optional folders appear only when used).
const SCAFFOLDED_AUTOMATION = ['pages', 'tests', 'helpers', 'fixtures', 'config'];
const FORBIDDEN_IN_AUTOMATION = ['engine', 'docs', 'demo', 'input', 'output', 'runs', 'state', 'utils', 'engine-tests'];

function project(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ab-init-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function init(root, ...args) {
  const r = spawnSync(process.execPath, [INIT, '--root', root, ...args], { encoding: 'utf8' });
  return { code: r.status, json: JSON.parse(r.stdout) };
}

const names = (dir) => readdirSync(dir).sort();

for (const language of ['typescript', 'javascript']) {
  test(`${language}: automation/ holds the framework only, the pipeline lives in dependencies/`, (t) => {
    const root = project(t);
    const { code, json } = init(root, '--language', language, '--with-demo', '--with-pipeline-tests');
    assert.equal(code, 0, JSON.stringify(json));

    const inAutomation = names(path.join(root, 'automation'));
    assert.deepEqual(inAutomation.filter((n) => !ALLOWED_IN_AUTOMATION.has(n)), [], 'only framework entries in automation/');
    for (const d of SCAFFOLDED_AUTOMATION) assert.ok(inAutomation.includes(d), `automation/${d}/ exists`);
    for (const d of FORBIDDEN_IN_AUTOMATION) assert.ok(!inAutomation.includes(d), `automation/${d}/ must not exist`);
    for (const d of ['test-data', 'auth', 'reports', 'test-results']) assert.ok(!inAutomation.includes(d), `optional automation/${d}/ is not pre-created`);
    assert.deepEqual(names(path.join(root, 'automation', 'tests')).filter((n) => n !== '.gitkeep'), [], 'tests/ is flat: no generated/ or handwritten/ subfolders');

    const inDependencies = names(path.join(root, 'dependencies'));
    for (const d of ['engine', 'docs', 'input', 'state', 'demo', 'engine-tests']) assert.ok(inDependencies.includes(d), `dependencies/${d}/ exists`);
    assert.ok(!inDependencies.includes('node_modules'), 'dependencies/ has no node_modules');
    assert.equal(JSON.parse(readFileSync(path.join(root, 'dependencies', 'state', 'scaffold.json'), 'utf8')).language, language);

    // The framework's mandatory helpers/ folder replaces utils/, and nothing imports the old name.
    assert.ok(existsSync(path.join(root, 'automation', 'helpers', language === 'typescript' ? 'test-data.ts' : 'test-data.js')));
    const fixture = readFileSync(path.join(root, 'automation', 'fixtures', language === 'typescript' ? 'test.ts' : 'test.js'), 'utf8');
    assert.match(fixture, /\.\.\/helpers\/test-data\./);
    assert.match(fixture, /\.\.\/\.\.\/dependencies\/engine\/config\/load-config\.ts/);

    // npm scripts: framework scripts in automation/, pipeline scripts in dependencies/.
    const fwScripts = JSON.parse(readFileSync(path.join(root, 'automation', 'package.json'), 'utf8')).scripts;
    const depScripts = JSON.parse(readFileSync(path.join(root, 'dependencies', 'package.json'), 'utf8')).scripts;
    assert.ok(fwScripts.test && !fwScripts.pipeline && !fwScripts['test:pipeline']);
    assert.ok(depScripts.pipeline && depScripts.test && depScripts['demo:app']);

    // Generated output is ignored in the framework; run state is ignored in dependencies.
    assert.match(readFileSync(path.join(root, 'automation', '.gitignore'), 'utf8'), /^reports\/$/m);
    assert.match(readFileSync(path.join(root, 'automation', '.gitignore'), 'utf8'), /^test-results\/$/m);
    assert.match(readFileSync(path.join(root, 'dependencies', '.gitignore'), 'utf8'), /^runs\/$/m);

    // Re-running changes nothing except re-stamping the scaffold record.
    const again = init(root, '--language', language, '--with-demo', '--with-pipeline-tests');
    assert.deepEqual([again.json.created, again.json.moved, again.json.removed, again.json.merged], [[], [], [], []]);
  });
}

test('the language is required the first time and cannot be switched', (t) => {
  const root = project(t);
  const missing = init(root);
  assert.equal(missing.code, 2);
  assert.equal(missing.json.needsInput, 'language');
  assert.equal(init(root, '--language', 'typescript').code, 0);
  const switched = init(root, '--language', 'javascript');
  assert.equal(switched.code, 1);
  assert.match(switched.json.error, /cannot be switched/);
});

// A minimal project as plugin 0.2.x scaffolded it: everything inside automation/.
function legacyProject(t) {
  const root = project(t);
  const at = (rel, text) => {
    const file = path.join(root, 'automation', rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  at('engine/cli/pipeline.ts', '// old engine\n');
  at('docs/test-spec-schema.md', '# old docs\n');
  at('tsconfig.engine.json', '{}\n');
  at('tests/pipeline/old.test.ts', "import '../../engine/x.ts';\n");
  at('input/test-cases/login.md', '## TC-1: Login\n');
  at('output/runs/20261019-083012-abc123/manifest.json', '{}\n');
  at('config/scaffold.json', JSON.stringify({ pluginVersion: '0.2.0', language: 'typescript' }));
  at('config/dependency-log.json', '[]\n');
  at('config/automation.config.json', '{"keep":"me"}\n');
  at('utils/test-data.ts', 'export const x = 1;\n');
  at('fixtures/test.ts', "import { loadConfig } from '../engine/config/load-config.ts';\nimport { redact } from '../utils/test-data.ts';\n");
  at('tests/generated/a.spec.ts', "import { requireEnv } from '../../utils/test-data.ts';\n");
  at('tests/handwritten/mine.spec.ts', "import { requireEnv } from '../../utils/test-data.ts';\n");
  at('tests/setup/auth.setup.ts', "await context.storageState({ path: '.auth/storage-state.json' });\n");
  at('package.json', JSON.stringify({
    name: 'x', type: 'module',
    scripts: { pipeline: 'node engine/cli/pipeline.ts', 'test:pipeline': 'node --test "tests/pipeline/**/*.test.ts"', validate: 'npm run typecheck:engine && npm run test:pipeline', test: 'playwright test' },
  }));
  return root;
}

test('migration: a 0.2.x layout is moved to automation/ + dependencies/ without losing user files', (t) => {
  const root = legacyProject(t);
  const dry = init(root, '--dry-run');
  assert.equal(dry.code, 0, JSON.stringify(dry.json));
  assert.equal(dry.json.migratedFromLegacyLayout, true);
  assert.ok(existsSync(path.join(root, 'automation', 'engine')), 'dry run changes nothing');

  const { code, json } = init(root, '--with-pipeline-tests');
  assert.equal(code, 0, JSON.stringify(json));
  const a = (rel) => path.join(root, 'automation', rel);
  const d = (rel) => path.join(root, 'dependencies', rel);

  const left = names(path.join(root, 'automation'));
  assert.deepEqual(left.filter((n) => !ALLOWED_IN_AUTOMATION.has(n)), [], `unexpected in automation/: ${left}`);
  assert.ok(existsSync(a('auth/auth.setup.ts')) && !existsSync(a('tests/setup')), 'login setup moved to auth/');
  assert.ok(!existsSync(a('tests/generated')) && !existsSync(a('tests/handwritten')), 'tests/ is flat');

  // Pipeline data moved, not lost.
  assert.equal(readFileSync(d('input/test-cases/login.md'), 'utf8'), '## TC-1: Login\n');
  assert.ok(existsSync(d('runs/20261019-083012-abc123/manifest.json')));
  assert.ok(existsSync(d('state/dependency-log.json')) && existsSync(d('state/scaffold.json')));
  assert.equal(JSON.parse(readFileSync(d('state/scaffold.json'), 'utf8')).pluginVersion, JSON.parse(readFileSync(path.resolve(path.dirname(INIT), '..', '.claude-plugin', 'plugin.json'), 'utf8')).version);
  assert.ok(existsSync(d('engine/utils/layout.ts')), 'engine refreshed to this plugin version');
  assert.ok(existsSync(d('engine-tests/end-to-end.test.ts')) && !existsSync(a('tests/pipeline')));

  // User files kept, with their imports updated to the new layout.
  assert.equal(readFileSync(a('config/automation.config.json'), 'utf8'), '{"keep":"me"}\n');
  assert.match(readFileSync(a('helpers/test-data.ts'), 'utf8'), /export const x = 1/);
  assert.match(readFileSync(a('fixtures/test.ts'), 'utf8'), /'\.\.\/\.\.\/dependencies\/engine\/config\/load-config\.ts'/);
  assert.match(readFileSync(a('fixtures/test.ts'), 'utf8'), /\.\.\/helpers\/test-data\.ts/);
  const generated = readFileSync(a('tests/a.spec.ts'), 'utf8');
  const handwritten = readFileSync(a('tests/mine.spec.ts'), 'utf8');
  assert.match(generated, /^\/\/ @automation-builder:generated/, 'moved generated spec gets the ownership header');
  assert.doesNotMatch(handwritten, /@automation-builder:generated/, 'handwritten spec stays unmarked');
  for (const text of [generated, handwritten]) assert.match(text, /from '\.\.\/helpers\/test-data\.ts'|'\.\.\/helpers\/test-data\.ts'/);
  assert.match(readFileSync(a('auth/auth.setup.ts'), 'utf8'), /'auth\/storage-state\.json'/);

  // Old engine scripts left automation/package.json and exist in dependencies/package.json.
  const fw = JSON.parse(readFileSync(a('package.json'), 'utf8')).scripts;
  assert.deepEqual([fw.pipeline, fw['test:pipeline'], fw.validate], [undefined, undefined, undefined]);
  assert.equal(fw.test, 'playwright test');
  assert.ok(JSON.parse(readFileSync(d('package.json'), 'utf8')).scripts.pipeline);
  assert.ok(json.warnings.some((w) => /moved to dependencies\/runs/.test(w)));

  // Idempotent: a second run is a no-op.
  const again = init(root, '--with-pipeline-tests');
  assert.equal(again.json.migratedFromLegacyLayout, false);
  assert.deepEqual([again.json.moved, again.json.removed, again.json.rewritten], [[], [], []]);
});

test('flattening: tests/generated + tests/handwritten of a 0.3.0 project move into tests/, clashes are kept and reported', (t) => {
  const root = project(t);
  assert.equal(init(root, '--language', 'typescript').code, 0);
  const at = (rel, text) => {
    const file = path.join(root, 'automation', rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  at('tests/generated/login.spec.ts', "import { test } from '../../fixtures/test.ts';\n");
  at('tests/generated/clash.spec.ts', "// generated clash\n");
  at('tests/handwritten/clash.spec.ts', "// handwritten clash\n");
  at('tests/handwritten/sub/deep.spec.ts', "import { test } from '../../../fixtures/test.ts';\nimport { helper } from '../local.ts';\n");
  at('tests/handwritten/local.ts', 'export const helper = 1;\n');

  const { code, json } = init(root, '--language', 'typescript');
  assert.equal(code, 0, JSON.stringify(json));
  const a = (rel) => path.join(root, 'automation', rel);
  assert.match(readFileSync(a('tests/login.spec.ts'), 'utf8'), /^\/\/ @automation-builder:generated[^\n]*\nimport \{ test \} from '\.\.\/fixtures\/test\.ts';/);
  // Nested handwritten file: only the import that left the old folder lost a level.
  assert.equal(readFileSync(a('tests/sub/deep.spec.ts'), 'utf8'), "import { test } from '../../fixtures/test.ts';\nimport { helper } from '../local.ts';\n");
  assert.ok(existsSync(a('tests/local.ts')));
  // The name clash: first mover (generated) wins nothing silently; the handwritten file is not overwritten.
  assert.equal(readFileSync(a('tests/clash.spec.ts'), 'utf8').includes('// handwritten clash'), true);
  assert.ok(existsSync(a('tests/generated/clash.spec.ts')), 'clashing generated file stays where it was');
  assert.ok(json.warnings.some((w) => /clash\.spec\.ts was not moved/.test(w)));
  assert.ok(!existsSync(a('tests/handwritten')));
});
