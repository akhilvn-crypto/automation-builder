#!/usr/bin/env node
// Scaffolds the Automation Builder framework into <root>/automation/: a self-contained Playwright project
// (TypeScript or JavaScript) plus the pipeline engine. Never installs packages and never overwrites an
// existing file unless --force / --update says so.
//
// Usage: node <plugin>/scripts/init.mjs --language typescript|javascript [--root <dir>] [--with-demo]
//                                       [--with-pipeline-tests] [--update] [--force] [--dry-run]
//   --language  required the first time (the caller must ask the user; it is never defaulted). Afterwards it is read
//               from automation/config/scaffold.json and cannot be changed.
//   --update    overwrite plugin-owned engine files (engine/, docs/, playwright.config.*, tsconfig*/jsconfig) with
//               this plugin version; user files (fixtures, pages, utils, tests, README) are left alone
//   --force     overwrite every scaffolded file
// Output: JSON summary on stdout. Exit 0 ok, 1 error, 2 a required answer (language) is missing.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(PLUGIN_ROOT, 'template');
const PLUGIN_VERSION = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const FOLDER = 'automation';
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
const target = path.join(projectRoot, FOLDER);
const dry = values['dry-run'];
const summary = {
  ok: true, projectRoot, folder: FOLDER, pluginVersion: PLUGIN_VERSION, dryRun: dry,
  language: null, created: [], overwritten: [], skipped: [], merged: [], warnings: [],
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

// Copy a template file or folder to <target>/<destRel>. Existing files are kept unless `overwrite`.
function copyEntry(srcRel, destRel, overwrite) {
  const src = path.join(TEMPLATE, srcRel);
  if (!existsSync(src)) throw new Error(`template is missing ${srcRel}`);
  const base = statSync(src).isDirectory() ? src : path.dirname(src);
  for (const file of walk(src)) {
    const dest = statSync(src).isDirectory() ? path.join(target, destRel, path.relative(base, file)) : path.join(target, destRel);
    const exists = existsSync(dest);
    if (exists && !overwrite) { summary.skipped.push(rel(dest)); continue; }
    if (!dry) { mkdirSync(path.dirname(dest), { recursive: true }); copyFileSync(file, dest); }
    (exists ? summary.overwritten : summary.created).push(rel(dest));
  }
}

function readScaffold() {
  try {
    const v = JSON.parse(readFileSync(path.join(target, 'config', 'scaffold.json'), 'utf8'));
    return LANGUAGES.includes(v.language) ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- language-specific content

const EXAMPLE = {
  typescript: `import { test, expect } from '../../fixtures/test.ts';
import { requireEnv } from '../../utils/test-data.ts';

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
  javascript: `import { test, expect } from '../../fixtures/test.js';
import { requireEnv } from '../../utils/test-data.js';

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

function scriptsFor(language) {
  const scripts = {
    pipeline: 'node engine/cli/pipeline.ts',
    test: 'playwright test',
    'test:headed': 'playwright test --headed',
    'test:ui': 'playwright test --ui',
    report: 'playwright show-report',
    'test:pipeline': 'node --test "tests/pipeline/**/*.test.ts"',
  };
  if (language === 'typescript') {
    scripts.typecheck = 'tsc --noEmit -p tsconfig.json';
    scripts['typecheck:engine'] = 'tsc --noEmit -p tsconfig.engine.json';
    scripts.validate = 'npm run typecheck:engine && npm run test:pipeline';
  } else {
    scripts.validate = 'npm run test:pipeline';
  }
  if (values['with-demo']) scripts['demo:app'] = 'node demo/server.ts';
  return scripts;
}

// ---------------------------------------------------------------- merges

function mergeGitignore() {
  const dest = path.join(target, '.gitignore');
  const wanted = readFileSync(path.join(TEMPLATE, 'framework', 'common', 'gitignore'), 'utf8');
  if (!existsSync(dest)) return writeText(dest, wanted, 'created');
  const current = readFileSync(dest, 'utf8');
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const add = wanted.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#') && !have.has(l.trim()));
  if (add.length === 0) return summary.skipped.push(rel(dest));
  writeText(dest, `${current.replace(/\s*$/, '\n')}\n# Automation Builder\n${add.join('\n')}\n`, 'merged');
}

function mergePackageJson(language) {
  const dest = path.join(target, 'package.json');
  const scripts = scriptsFor(language);
  if (!existsSync(dest)) {
    const name = `${path.basename(projectRoot).toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}-automation`;
    const pkg = {
      name, private: true, type: 'module', description: `Playwright (${language}) test automation`,
      engines: { node: '>=24' }, scripts,
    };
    return writeText(dest, JSON.stringify(pkg, null, 2) + '\n', 'created');
  }
  const pkg = JSON.parse(readFileSync(dest, 'utf8').replace(/^﻿/, ''));
  pkg.scripts ??= {};
  let changed = false;
  for (const [k, v] of Object.entries(scripts)) {
    if (pkg.scripts[k] === undefined) { pkg.scripts[k] = v; changed = true; }
    else if (pkg.scripts[k] !== v) summary.warnings.push(`${FOLDER}/package.json script "${k}" already exists and was left as is`);
  }
  if (pkg.type !== 'module') {
    summary.warnings.push(`${FOLDER}/package.json "type" is ${JSON.stringify(pkg.type ?? null)}; the pipeline needs "module"${pkg.type === undefined ? ' (set now)' : ' — fix it manually'}`);
    if (pkg.type === undefined) { pkg.type = 'module'; changed = true; }
  }
  if (changed) writeText(dest, JSON.stringify(pkg, null, 2) + '\n', 'merged');
  else summary.skipped.push(rel(dest));
}

function mergeClaudeMd() {
  const dest = path.join(projectRoot, 'CLAUDE.md');
  const block = readFileSync(path.join(TEMPLATE, 'CLAUDE.automation-builder.md'), 'utf8');
  const marker = '<!-- automation-builder:start -->';
  if (!existsSync(dest)) return writeText(dest, block, 'created');
  const current = readFileSync(dest, 'utf8');
  if (current.includes(marker)) {
    if (!values.update && !values.force) return summary.skipped.push('CLAUDE.md');
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
    throw new Error(`${FOLDER}/ was scaffolded as ${language} and cannot be switched in place. Scaffold a fresh project, or move ${FOLDER}/ aside first.`);
  }
  if (!language) {
    if (!values.language) throw new NeedsInput('language', '--language typescript|javascript is required. Ask the user which language they want; it is not defaulted and cannot be changed later.');
    language = values.language;
  }
  summary.language = language;
  const ext = language === 'typescript' ? 'ts' : 'js';
  const fw = `framework/${language}`;

  if (!existsSync(target) && existsSync(path.join(projectRoot, 'src', 'cli', 'pipeline.ts'))) {
    summary.warnings.push('A pipeline from an older plugin version was found at the project root (src/cli/pipeline.ts). It was left untouched; the new framework lives in automation/ and starts with fresh config and runs.');
  }

  const overwriteEngine = values.update || values.force;
  // Plugin-owned: refreshed by --update.
  copyEntry('engine', 'engine', overwriteEngine);
  copyEntry('docs', 'docs', overwriteEngine);
  copyEntry(`${fw}/playwright.config.${ext}`, `playwright.config.${ext}`, overwriteEngine);
  if (language === 'typescript') {
    copyEntry(`${fw}/tsconfig.json`, 'tsconfig.json', overwriteEngine);
    copyEntry(`${fw}/tsconfig.engine.json`, 'tsconfig.engine.json', overwriteEngine);
  } else {
    copyEntry(`${fw}/jsconfig.json`, 'jsconfig.json', overwriteEngine);
  }
  // User-extensible: created once, overwritten only with --force.
  for (const d of ['fixtures', 'pages', 'utils']) copyEntry(`${fw}/${d}`, d, values.force);
  copyEntry('framework/common/.env.example', '.env.example', values.force);
  if (values['with-demo']) copyEntry('demo', 'demo', values.force);
  if (values['with-pipeline-tests']) copyEntry('tests/pipeline', 'tests/pipeline', values.force);

  const readme = path.join(target, 'README.md');
  if (!existsSync(readme) || values.force) writeText(readme, renderReadme(language), existsSync(readme) ? 'overwritten' : 'created');
  else summary.skipped.push(rel(readme));

  for (const d of ['tests/generated', 'tests/handwritten', 'tests/setup', 'input/test-cases', 'config']) {
    const dir = path.join(target, d);
    if (!existsSync(dir)) writeText(path.join(dir, '.gitkeep'), '', 'created');
  }

  mergeGitignore();
  mergePackageJson(language);
  mergeClaudeMd();

  const scaffoldFile = path.join(target, 'config', 'scaffold.json');
  writeText(scaffoldFile, JSON.stringify({ pluginVersion: PLUGIN_VERSION, language }, null, 2) + '\n', existsSync(scaffoldFile) ? 'overwritten' : 'created');

  summary.next = [
    language === 'typescript'
      ? 'Nothing was installed. Dev tooling (installed only with your approval, one by one): typescript, @types/node, @playwright/test, browser(s).'
      : 'Nothing was installed. Dev tooling (installed only with your approval, one by one): @playwright/test, browser(s). TypeScript is not needed for a JavaScript project.',
    `Dependencies install into ${FOLDER}/ (its own package.json and node_modules).`,
    `Run /automation-builder:playwright-pipeline ${FOLDER}/input/test-cases — preflight will ask for each missing dependency and setting.`,
  ];
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
} catch (err) {
  const needs = err instanceof NeedsInput ? { needsInput: err.field } : {};
  process.stdout.write(JSON.stringify({ ...summary, ok: false, ...needs, error: err.message }, null, 2) + '\n');
  process.exitCode = err instanceof NeedsInput ? 2 : 1;
}
