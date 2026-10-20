#!/usr/bin/env node
// Scaffolds the Automation Builder framework (pipeline CLI, config, fixtures, Playwright config) into a project.
// Never installs packages and never overwrites an existing file unless --force / --update says so.
//
// Usage: node <plugin>/scripts/init.mjs [--root <dir>] [--with-demo] [--with-pipeline-tests]
//                                       [--update] [--force] [--dry-run]
//   --update   overwrite plugin-owned engine files (src/cli, src/config, src/pipeline, src/tools, docs,
//              playwright.config.ts, tsconfigs) with this plugin version; user files are left alone
//   --force    overwrite every scaffolded file
// Output: JSON summary on stdout. Exit 0 ok, 1 error.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(PLUGIN_ROOT, 'template');
const PLUGIN_VERSION = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    'with-demo': { type: 'boolean', default: false },
    'with-pipeline-tests': { type: 'boolean', default: false },
    update: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

const root = path.resolve(values.root ?? process.cwd());
const dry = values['dry-run'];
const summary = { ok: true, root, pluginVersion: PLUGIN_VERSION, dryRun: dry, created: [], overwritten: [], skipped: [], merged: [], warnings: [] };

// Plugin-owned engine files: safe to overwrite on --update.
const ENGINE = ['src/cli', 'src/config', 'src/pipeline', 'src/tools', 'docs', 'playwright.config.ts', 'tsconfig.json', 'tsconfig.framework.json'];
// Framework files the user may extend: created once, overwritten only with --force.
const FRAMEWORK = ['src/fixtures', 'src/utils', '.env.example'];
const OPTIONAL = [...(values['with-demo'] ? ['demo'] : []), ...(values['with-pipeline-tests'] ? ['tests/pipeline'] : [])];
const EMPTY_DIRS = ['tests/generated', 'tests/handwritten', 'src/pages', 'input/test-cases', 'config'];

const rel = (abs) => path.relative(root, abs).split(path.sep).join('/');

function walk(abs) {
  if (!statSync(abs).isDirectory()) return [abs];
  return readdirSync(abs).flatMap((n) => walk(path.join(abs, n)));
}

function copyEntry(entry, overwrite) {
  const src = path.join(TEMPLATE, entry);
  if (!existsSync(src)) throw new Error(`template is missing ${entry}`);
  for (const file of walk(src)) {
    const dest = path.join(root, path.relative(TEMPLATE, file));
    const exists = existsSync(dest);
    if (exists && !overwrite) { summary.skipped.push(rel(dest)); continue; }
    if (!dry) { mkdirSync(path.dirname(dest), { recursive: true }); copyFileSync(file, dest); }
    (exists ? summary.overwritten : summary.created).push(rel(dest));
  }
}

function writeText(dest, text, bucket) {
  if (!dry) { mkdirSync(path.dirname(dest), { recursive: true }); writeFileSync(dest, text); }
  summary[bucket].push(rel(dest));
}

function mergeGitignore() {
  const dest = path.join(root, '.gitignore');
  const wanted = readFileSync(path.join(TEMPLATE, 'gitignore'), 'utf8');
  if (!existsSync(dest)) return writeText(dest, wanted, 'created');
  const current = readFileSync(dest, 'utf8');
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const add = wanted.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#') && !have.has(l.trim()));
  if (add.length === 0) return summary.skipped.push('.gitignore');
  writeText(dest, `${current.replace(/\s*$/, '\n')}\n# Automation Builder\n${add.join('\n')}\n`, 'merged');
}

function mergePackageJson() {
  const dest = path.join(root, 'package.json');
  const tpl = JSON.parse(readFileSync(path.join(TEMPLATE, 'package.json'), 'utf8'));
  if (!existsSync(dest)) {
    const pkg = { name: path.basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, '-'), ...tpl };
    return writeText(dest, JSON.stringify(pkg, null, 2) + '\n', 'created');
  }
  const pkg = JSON.parse(readFileSync(dest, 'utf8').replace(/^﻿/, ''));
  pkg.scripts ??= {};
  let changed = false;
  for (const [k, v] of Object.entries(tpl.scripts)) {
    if (k === 'demo:app' && !values['with-demo']) continue;
    if (pkg.scripts[k] === undefined) { pkg.scripts[k] = v; changed = true; }
    else if (pkg.scripts[k] !== v) summary.warnings.push(`package.json script "${k}" already exists and was left as is`);
  }
  // The engine and tsconfig (verbatimModuleSyntax) need ES modules; typecheck fails under CommonJS.
  if (pkg.type === undefined) {
    pkg.type = 'module'; changed = true;
    summary.warnings.push('package.json: set "type": "module" (required by the pipeline). Existing CommonJS .js files would need renaming to .cjs');
  } else if (pkg.type !== 'module') {
    summary.warnings.push(`package.json "type" is "${pkg.type}"; the pipeline needs "module" — typecheck will fail until it is changed`);
  }
  if (changed) writeText(dest, JSON.stringify(pkg, null, 2) + '\n', 'merged');
  else summary.skipped.push('package.json');
}

function mergeClaudeMd() {
  const dest = path.join(root, 'CLAUDE.md');
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

try {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) summary.warnings.push(`Node ${process.versions.node} detected; the pipeline needs Node 24+ (TypeScript type stripping)`);
  if (!existsSync(root)) throw new Error(`root does not exist: ${root}`);

  for (const e of ENGINE) copyEntry(e, values.update || values.force);
  for (const e of [...FRAMEWORK, ...OPTIONAL]) copyEntry(e, values.force);
  for (const d of EMPTY_DIRS) {
    const keep = path.join(root, d, '.gitkeep');
    if (!existsSync(path.join(root, d))) writeText(keep, '', 'created');
  }
  mergeGitignore();
  mergePackageJson();
  mergeClaudeMd();
  writeText(path.join(root, 'config', '.automation-builder-version'), PLUGIN_VERSION + '\n', existsSync(path.join(root, 'config', '.automation-builder-version')) ? 'overwritten' : 'created');

  summary.next = [
    'Nothing was installed. Dev tooling the pipeline expects (installed only with your approval): typescript, @types/node, @playwright/test + browser(s).',
    'Run /automation-builder:playwright-pipeline <test-case path> — preflight will ask for each missing dependency and setting.',
  ];
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
} catch (err) {
  process.stdout.write(JSON.stringify({ ...summary, ok: false, error: err.message }, null, 2) + '\n');
  process.exitCode = 1;
}
