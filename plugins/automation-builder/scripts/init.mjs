#!/usr/bin/env node
// Scaffolds the Automation Builder into two sibling folders of <root>:
//
//   automation/     the Playwright framework ONLY — the structure in playwright_framework_structure.md:
//                   pages/ tests/ helpers/ (mandatory), fixtures/ config/ (and test-data/ auth/ reports/ test-results/
//                   when used), playwright.config.*, package.json, .gitignore, .env.example, README.md.
//   dependencies/   everything the pipeline needs that is not framework: engine/, docs/, input/test-cases/, runs/
//                   (run state), state/ (scaffold + dependency log), plus the optional demo and engine tests.
//
// Never installs packages and never overwrites an existing file unless --force / --update says so.
//
// Usage: node <plugin>/scripts/init.mjs --language typescript|javascript [--root <dir>] [--with-demo]
//                                       [--with-pipeline-tests] [--update] [--force] [--dry-run]
//   --language  required the first time (the caller must ask the user; it is never defaulted). Afterwards it is read
//               from dependencies/state/scaffold.json and cannot be changed.
//   --update    overwrite plugin-owned files (dependencies/engine, dependencies/docs, dependencies/tsconfig.json,
//               automation/playwright.config.*, automation/tsconfig.json|jsconfig.json) with this plugin version; user
//               files (fixtures, pages, helpers, tests, README) are left alone
//   --force     overwrite every scaffolded file
//
// A project scaffolded by plugin 0.2.x kept everything in automation/ (engine/, docs/, input/, output/, utils/, ...).
// That layout is detected and migrated automatically (see migrateLegacyLayout); --dry-run lists what would change.
//
// Output: JSON summary on stdout. Exit 0 ok, 1 error, 2 a required answer (language) is missing.

import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(PLUGIN_ROOT, 'template');
const PLUGIN_VERSION = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const FRAMEWORK = 'automation';
const DEPENDENCIES = 'dependencies';
const LANGUAGES = ['typescript', 'javascript'];

const { values } = parseArgs({
  options: {
    language: { type: 'string' },
    root: { type: 'string' },
    'with-demo': { type: 'boolean', default: false },
    'with-pipeline-tests': { type: 'boolean', default: false },
    update: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

const projectRoot = path.resolve(values.root ?? process.cwd());
const fw = path.join(projectRoot, FRAMEWORK);
const dep = path.join(projectRoot, DEPENDENCIES);
const dry = values['dry-run'];
const summary = {
  ok: true, projectRoot, frameworkFolder: FRAMEWORK, dependenciesFolder: DEPENDENCIES, pluginVersion: PLUGIN_VERSION, dryRun: dry,
  language: null, migratedFromLegacyLayout: false,
  created: [], overwritten: [], skipped: [], merged: [], moved: [], removed: [], rewritten: [], warnings: [],
};

class NeedsInput extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

const rel = (abs) => path.relative(projectRoot, abs).split(path.sep).join('/');

function walk(abs) {
  if (!statSync(abs).isDirectory()) return [abs];
  return readdirSync(abs).flatMap((n) => walk(path.join(abs, n)));
}

function writeText(dest, text, bucket) {
  if (!dry) { mkdirSync(path.dirname(dest), { recursive: true }); writeFileSync(dest, text); }
  summary[bucket].push(rel(dest));
}

// Copy a template file or folder to <baseDir>/<destRel>. Existing files are kept unless `overwrite`.
function copyEntry(srcRel, baseDir, destRel, overwrite) {
  const src = path.join(TEMPLATE, srcRel);
  if (!existsSync(src)) throw new Error(`template is missing ${srcRel}`);
  const isDir = statSync(src).isDirectory();
  for (const file of walk(src)) {
    const dest = isDir ? path.join(baseDir, destRel, path.relative(src, file)) : path.join(baseDir, destRel);
    const exists = existsSync(dest);
    if (exists && !overwrite) { summary.skipped.push(rel(dest)); continue; }
    if (!dry) { mkdirSync(path.dirname(dest), { recursive: true }); copyFileSync(file, dest); }
    (exists ? summary.overwritten : summary.created).push(rel(dest));
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- legacy layout (plugin 0.2.x)

const LEGACY_SCAFFOLD = path.join(fw, 'config', 'scaffold.json');
const NEW_SCAFFOLD = path.join(dep, 'state', 'scaffold.json');

function isLegacyLayout() {
  return existsSync(path.join(fw, 'engine')) || existsSync(LEGACY_SCAFFOLD);
}

function readScaffold() {
  for (const file of [NEW_SCAFFOLD, LEGACY_SCAFFOLD]) {
    const v = readJsonFile(file);
    if (v && LANGUAGES.includes(v.language)) return v;
  }
  return null;
}

function move(from, to) {
  if (!existsSync(from)) return;
  if (existsSync(to)) {
    summary.warnings.push(`${rel(from)} was not moved: ${rel(to)} already exists. Merge them manually.`);
    return;
  }
  if (!dry) { mkdirSync(path.dirname(to), { recursive: true }); renameSync(from, to); }
  summary.moved.push(`${rel(from)} -> ${rel(to)}`);
}

function remove(p) {
  if (!existsSync(p)) return;
  if (!dry) rmSync(p, { recursive: true, force: true });
  summary.removed.push(rel(p));
}

function dirIsEmpty(p) {
  return existsSync(p) && readdirSync(p).filter((n) => n !== '.gitkeep').length === 0;
}

// Generated and handwritten tests used to live in tests/generated/ and tests/handwritten/. They now share tests/;
// pipeline-owned files are recognised by a header comment (same text as GENERATED_HEADER in the engine).
const GENERATED_MARKER = '@automation-builder:generated';
const GENERATED_HEADER = `// ${GENERATED_MARKER} — owned by the pipeline (regenerated and healed by it). Delete this line to take ownership of the file.`;

// Moves tests/generated/** and tests/handwritten/** up into tests/. Imports that climbed out of the old folder lose one
// "../"; moved generated spec files get the ownership header. Never overwrites: a name clash is left in place and reported.
function flattenTests() {
  const testsDir = path.join(fw, 'tests');
  // The user's handwritten files claim names first, so a clash never displaces them.
  const groups = [[path.join(testsDir, 'handwritten'), false], [path.join(testsDir, 'generated'), true]].filter(([d]) => existsSync(d));
  if (groups.length === 0) return;
  summary.migratedFromLegacyLayout = true;
  for (const [dir, pipelineOwned] of groups) {
    let clashes = 0;
    for (const file of walk(dir).filter((f) => path.basename(f) !== '.gitkeep')) {
      const inDir = path.relative(dir, file);
      const dest = path.join(testsDir, inDir);
      if (existsSync(dest)) {
        clashes++;
        summary.warnings.push(`${rel(file)} was not moved: ${rel(dest)} already exists. Rename one of them.`);
        continue;
      }
      const depth = inDir.split(path.sep).length - 1;
      let text = readFileSync(file, 'utf8');
      const before = text;
      text = text.replace(/(['"])((?:\.\.\/)+)/g, (m, q, ups) => (ups.length / 3 > depth ? `${q}${'../'.repeat(ups.length / 3 - 1)}` : m));
      const owned = text.split(/\r?\n/, 5).some((l) => l.includes(GENERATED_MARKER));
      if (pipelineOwned && /\.spec\.(?:ts|js)$/.test(file) && !owned) text = `${GENERATED_HEADER}\n${text}`;
      if (!dry) {
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, text);
        rmSync(file);
      }
      summary.moved.push(`${rel(file)} -> ${rel(dest)}`);
      if (text !== before) summary.rewritten.push(rel(dest));
    }
    if (clashes === 0) {
      if (!dry) rmSync(dir, { recursive: true, force: true });
      summary.removed.push(rel(dir));
    }
  }
}

// Source files of the user's framework that mention paths the new layout changed.
function frameworkSourceFiles() {
  return ['fixtures', 'pages', 'helpers', 'utils', 'tests', 'auth'].flatMap((d) => {
    const dir = path.join(fw, d);
    const legacyEngineTests = path.join(fw, 'tests', 'pipeline'); // replaced by the migration, so not rewritten
    return existsSync(dir) ? walk(dir).filter((f) => /\.(?:ts|js|mjs)$/.test(f) && !f.startsWith(legacyEngineTests + path.sep)) : [];
  });
}

function rewriteFile(file, pairs) {
  const before = readFileSync(file, 'utf8');
  let after = before;
  for (const [from, to] of pairs) after = after.split(from).join(to);
  if (after === before) return;
  if (!dry) writeFileSync(file, after);
  summary.rewritten.push(rel(file));
}

function migrateLegacyLayout() {
  summary.migratedFromLegacyLayout = true;

  // Plugin-managed copies: replaced by the new versions in dependencies/ (refreshed below).
  for (const p of ['engine', 'docs', 'tsconfig.engine.json', path.join('tests', 'pipeline')]) remove(path.join(fw, p));

  // Pipeline data and tooling that is not framework moves out.
  move(path.join(fw, 'demo'), path.join(dep, 'demo'));
  move(path.join(fw, 'input'), path.join(dep, 'input'));
  move(path.join(fw, 'output', 'runs'), path.join(dep, 'runs'));
  if (!dry && dirIsEmpty(path.join(fw, 'output'))) rmSync(path.join(fw, 'output'), { recursive: true, force: true });
  move(LEGACY_SCAFFOLD, NEW_SCAFFOLD);
  move(path.join(fw, 'config', 'dependency-log.json'), path.join(dep, 'state', 'dependency-log.json'));
  if (existsSync(path.join(dep, 'runs'))) {
    summary.warnings.push('Runs from the old layout were moved to dependencies/runs/. They are kept as history; do not resume them (their report/evidence paths follow the old layout).');
  }

  // utils/ is now helpers/ (the mandatory folder name in the framework structure).
  move(path.join(fw, 'utils'), path.join(fw, 'helpers'));

  // Login setup lives in auth/ (and the saved state is auth/storage-state.json, not .auth/).
  const setupDir = path.join(fw, 'tests', 'setup');
  if (dirIsEmpty(setupDir)) {
    remove(setupDir);
  } else if (existsSync(setupDir)) {
    for (const f of readdirSync(setupDir).filter((n) => n !== '.gitkeep')) move(path.join(setupDir, f), path.join(fw, 'auth', f));
    remove(path.join(setupDir, '.gitkeep'));
    if (!dry && dirIsEmpty(setupDir)) rmSync(setupDir, { recursive: true, force: true });
    summary.warnings.push('tests/setup/ moved to auth/. Check the moved setup file(s): the storage state is now saved to auth/storage-state.json.');
  }

  // tests/generated + tests/handwritten -> tests/ (before the import rewrite below sees the files).
  flattenTests();

  // Import paths in the user's own framework files.
  for (const file of frameworkSourceFiles()) {
    rewriteFile(file, [
      ['/utils/test-data.', '/helpers/test-data.'],
      [`'../engine/config/`, `'../../dependencies/engine/config/`],
      ['.auth/storage-state.json', 'auth/storage-state.json'],
    ]);
  }

  // Scripts the old package.json carried for the engine now live in dependencies/package.json.
  const pkgFile = path.join(fw, 'package.json');
  const pkg = readJsonFile(pkgFile);
  if (pkg?.scripts) {
    const legacy = {
      pipeline: 'node engine/cli/pipeline.ts',
      'typecheck:engine': 'tsc --noEmit -p tsconfig.engine.json',
      'test:pipeline': 'node --test "tests/pipeline/**/*.test.ts"',
      report: 'playwright show-report', // now points at reports/adhoc/html
      validate: undefined, // value depends on the language; matched by name below
      'demo:app': 'node demo/server.ts',
    };
    let changed = false;
    for (const [name, value] of Object.entries(legacy)) {
      const current = pkg.scripts[name];
      if (current === undefined) continue;
      if (value === undefined ? /^(npm run typecheck:engine && )?npm run test:pipeline$/.test(current) : current === value) {
        delete pkg.scripts[name];
        changed = true;
      } else summary.warnings.push(`automation/package.json script "${name}" was customised and still points at the old layout; move or fix it manually`);
    }
    if (changed) writeText(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'rewritten');
  }
}

// ---------------------------------------------------------------- language-specific content

const EXAMPLE = {
  typescript: `import { test, expect } from '../fixtures/test.ts';
import { requireEnv } from '../helpers/test-data.ts';

test.describe('Sign in', () => {
  test('[LOGIN-001] Valid user can sign in', { annotation: { type: 'testId', description: 'LOGIN-001' }, tag: ['@smoke'] }, async ({ page }) => {
    await test.step('Open the login page', async () => {
      await page.goto('/login');
    });
    await test.step('Sign in', async () => {
      await page.getByLabel('Email').fill(requireEnv('TEST_USER_EMAIL'));
      await page.getByLabel('Password').fill(requireEnv('TEST_USER_PASSWORD'));
      await page.getByRole('button', { name: 'Sign in' }).click();
    });
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});`,
  javascript: `import { test, expect } from '../fixtures/test.js';
import { requireEnv } from '../helpers/test-data.js';

test.describe('Sign in', () => {
  test('[LOGIN-001] Valid user can sign in', { annotation: { type: 'testId', description: 'LOGIN-001' }, tag: ['@smoke'] }, async ({ page }) => {
    await test.step('Open the login page', async () => {
      await page.goto('/login');
    });
    await test.step('Sign in', async () => {
      await page.getByLabel('Email').fill(requireEnv('TEST_USER_EMAIL'));
      await page.getByLabel('Password').fill(requireEnv('TEST_USER_PASSWORD'));
      await page.getByRole('button', { name: 'Sign in' }).click();
    });
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});`,
};

function renderReadme(language) {
  const ts = language === 'typescript';
  const text = readFileSync(path.join(TEMPLATE, 'framework', 'common', 'README.md'), 'utf8');
  return text
    .replaceAll('{{LANGUAGE}}', ts ? 'TypeScript' : 'JavaScript')
    .replaceAll('{{EXT}}', ts ? 'ts' : 'js')
    .replaceAll('{{FENCE}}', ts ? 'ts' : 'js')
    .replaceAll('{{EXAMPLE}}', EXAMPLE[language]);
}

// Framework scripts only. The pipeline's own scripts live in dependencies/package.json.
function frameworkScripts(language) {
  const scripts = {
    test: 'playwright test',
    'test:headed': 'playwright test --headed',
    'test:ui': 'playwright test --ui',
    report: 'playwright show-report reports/adhoc/html',
  };
  if (language === 'typescript') scripts.typecheck = 'tsc --noEmit -p tsconfig.json';
  return scripts;
}

function dependenciesScripts(language) {
  const scripts = { pipeline: 'node engine/cli/pipeline.ts' };
  const hasTests = values['with-pipeline-tests'] || existsSync(path.join(dep, 'engine-tests'));
  if (hasTests) scripts.test = 'node --test "engine-tests/**/*.test.ts"';
  if (language === 'typescript') {
    // TypeScript is installed once, in automation/; dependencies/ borrows it.
    scripts.typecheck = 'node ../automation/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json';
    scripts.validate = hasTests ? 'npm run typecheck && npm test' : 'npm run typecheck';
  } else if (hasTests) {
    scripts.validate = 'npm test';
  }
  if (values['with-demo'] || existsSync(path.join(dep, 'demo'))) scripts['demo:app'] = 'node demo/server.ts';
  return scripts;
}

// ---------------------------------------------------------------- merges

function mergeGitignore(dir, wantedText) {
  const dest = path.join(dir, '.gitignore');
  if (!existsSync(dest)) return writeText(dest, wantedText, 'created');
  const current = readFileSync(dest, 'utf8');
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const add = wantedText.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#') && !have.has(l.trim()));
  if (add.length === 0) return summary.skipped.push(rel(dest));
  writeText(dest, `${current.replace(/\s*$/, '\n')}\n# Automation Builder\n${add.join('\n')}\n`, 'merged');
}

function mergePackageJson(dir, defaults, scripts) {
  const dest = path.join(dir, 'package.json');
  const label = rel(dest);
  if (!existsSync(dest)) {
    return writeText(dest, JSON.stringify({ ...defaults, private: true, type: 'module', engines: { node: '>=24' }, scripts }, null, 2) + '\n', 'created');
  }
  const pkg = JSON.parse(readFileSync(dest, 'utf8').replace(/^﻿/, ''));
  pkg.scripts ??= {};
  let changed = false;
  for (const [k, v] of Object.entries(scripts)) {
    if (pkg.scripts[k] === undefined) { pkg.scripts[k] = v; changed = true; }
    else if (pkg.scripts[k] !== v) summary.warnings.push(`${label} script "${k}" already exists and was left as is`);
  }
  if (pkg.type !== 'module') {
    summary.warnings.push(`${label} "type" is ${JSON.stringify(pkg.type ?? null)}; the pipeline needs "module"${pkg.type === undefined ? ' (set now)' : ' — fix it manually'}`);
    if (pkg.type === undefined) { pkg.type = 'module'; changed = true; }
  }
  if (changed) writeText(dest, JSON.stringify(pkg, null, 2) + '\n', 'merged');
  else summary.skipped.push(label);
}

function mergeClaudeMd() {
  const dest = path.join(projectRoot, 'CLAUDE.md');
  const block = readFileSync(path.join(TEMPLATE, 'CLAUDE.automation-builder.md'), 'utf8');
  const marker = '<!-- automation-builder:start -->';
  if (!existsSync(dest)) return writeText(dest, block, 'created');
  const current = readFileSync(dest, 'utf8');
  if (current.includes(marker)) {
    if (!values.update && !values.force && !summary.migratedFromLegacyLayout) return summary.skipped.push('CLAUDE.md');
    const next = current.replace(/<!-- automation-builder:start -->[\s\S]*?<!-- automation-builder:end -->\n?/, block);
    return writeText(dest, next, 'merged');
  }
  writeText(dest, `${current.replace(/\s*$/, '\n')}\n${block}`, 'merged');
}

// ---------------------------------------------------------------- main

try {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) summary.warnings.push(`Node ${process.versions.node} detected; the pipeline needs Node 24+ (TypeScript type stripping)`);
  if (!existsSync(projectRoot)) throw new Error(`root does not exist: ${projectRoot}`);

  // The language is the user's choice, made once: the scaffolded files are language-specific.
  const scaffold = readScaffold();
  let language = scaffold?.language ?? null;
  if (values.language !== undefined && !LANGUAGES.includes(values.language)) {
    throw new Error(`--language must be one of: ${LANGUAGES.join(', ')} (got "${values.language}")`);
  }
  if (language && values.language && values.language !== language) {
    throw new Error(`${FRAMEWORK}/ was scaffolded as ${language} and cannot be switched in place. Scaffold a fresh project, or move ${FRAMEWORK}/ and ${DEPENDENCIES}/ aside first.`);
  }
  if (!language) {
    if (!values.language) throw new NeedsInput('language', '--language typescript|javascript is required. Ask the user which language they want; it is not defaulted and cannot be changed later.');
    language = values.language;
  }
  summary.language = language;
  const ext = language === 'typescript' ? 'ts' : 'js';
  const tpl = `framework/${language}`;

  if (!existsSync(fw) && existsSync(path.join(projectRoot, 'src', 'cli', 'pipeline.ts'))) {
    summary.warnings.push('A pipeline from an older plugin version was found at the project root (src/cli/pipeline.ts). It was left untouched; the new layout lives in automation/ and dependencies/ and starts with fresh config and runs.');
  }

  const legacy = isLegacyLayout();
  if (legacy) migrateLegacyLayout();
  else flattenTests(); // a 0.3.0 project still has tests/generated + tests/handwritten

  // Plugin-owned: refreshed by --update (and when migrating, since the moved copies were removed or are stale).
  const overwriteOwned = values.update || values.force || legacy;
  copyEntry('dependencies/engine', dep, 'engine', overwriteOwned);
  copyEntry('dependencies/docs', dep, 'docs', overwriteOwned);
  copyEntry(`${tpl}/playwright.config.${ext}`, fw, `playwright.config.${ext}`, overwriteOwned);
  if (language === 'typescript') {
    copyEntry(`${tpl}/tsconfig.json`, fw, 'tsconfig.json', overwriteOwned);
    copyEntry('dependencies/tsconfig.json', dep, 'tsconfig.json', overwriteOwned);
  } else {
    copyEntry(`${tpl}/jsconfig.json`, fw, 'jsconfig.json', overwriteOwned);
  }
  if (values['with-pipeline-tests'] || (legacy && summary.removed.some((r) => r.endsWith('tests/pipeline')))) {
    copyEntry('dependencies/engine-tests', dep, 'engine-tests', overwriteOwned);
  }
  if (values['with-demo']) copyEntry('dependencies/demo', dep, 'demo', values.force);

  // Framework, user-extensible: created once, overwritten only with --force.
  for (const d of ['fixtures', 'pages', 'helpers']) copyEntry(`${tpl}/${d}`, fw, d, values.force);
  copyEntry('framework/common/.env.example', fw, '.env.example', values.force);

  const readme = path.join(fw, 'README.md');
  if (!existsSync(readme) || values.force) writeText(readme, renderReadme(language), existsSync(readme) ? 'overwritten' : 'created');
  else summary.skipped.push(rel(readme));

  // Folders the pipeline always needs. Optional framework folders (test-data/, auth/, reports/, test-results/) are
  // created when something actually uses them, not up front.
  for (const d of [path.join(fw, 'tests'), path.join(fw, 'config'), path.join(dep, 'input', 'test-cases')]) {
    if (!existsSync(d)) writeText(path.join(d, '.gitkeep'), '', 'created');
  }

  mergeGitignore(fw, readFileSync(path.join(TEMPLATE, 'framework', 'common', 'gitignore'), 'utf8'));
  mergeGitignore(dep, readFileSync(path.join(TEMPLATE, 'dependencies', 'gitignore'), 'utf8'));
  const base = path.basename(projectRoot).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  mergePackageJson(fw, { name: `${base}-automation`, description: `Playwright (${language}) test automation` }, frameworkScripts(language));
  mergePackageJson(dep, { name: `${base}-automation-dependencies`, description: 'Automation Builder pipeline: engine, docs, test-case input and run state' }, dependenciesScripts(language));
  mergeClaudeMd();

  writeText(NEW_SCAFFOLD, JSON.stringify({ pluginVersion: PLUGIN_VERSION, language }, null, 2) + '\n', existsSync(NEW_SCAFFOLD) ? 'overwritten' : 'created');

  summary.next = [
    language === 'typescript'
      ? 'Nothing was installed. Dev tooling (installed only with your approval, one by one, into automation/): typescript, @types/node, @playwright/test, browser(s).'
      : 'Nothing was installed. Dev tooling (installed only with your approval, one by one, into automation/): @playwright/test, browser(s). TypeScript is not needed for a JavaScript project.',
    `Dependencies install into ${FRAMEWORK}/ (its own package.json and node_modules); ${DEPENDENCIES}/ has no node_modules.`,
    `Put test cases in ${DEPENDENCIES}/input/test-cases/, then run /automation-builder:playwright-pipeline ${DEPENDENCIES}/input/test-cases — preflight will ask for each missing dependency and setting.`,
  ];
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
} catch (err) {
  const needs = err instanceof NeedsInput ? { needsInput: err.field } : {};
  process.stdout.write(JSON.stringify({ ...summary, ok: false, ...needs, error: err.message }, null, 2) + '\n');
  process.exitCode = err instanceof NeedsInput ? 2 : 1;
}
