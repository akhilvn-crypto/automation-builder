// Generation manifest written by the playwright-generator agent: output/runs/<run-id>/generation-manifest.json.
// Maps every ready spec to a generated test (or an explicit exclusion) for traceability.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isAbsoluteOrEscaping, type Language } from '../config/schema.ts';
import type { TestSpecDocument } from './test-spec.ts';

export const GENERATION_SCHEMA_VERSION = 1;
export const GENERATED_TESTS_DIR = 'tests/generated';
export const PAGE_OBJECTS_DIR = 'pages';

export function specFileExtension(language: Language): string {
  return language === 'typescript' ? '.spec.ts' : '.spec.js';
}

// Generated test titles start with "[<testId>] " so results map back to source cases.
export function testTitlePrefix(testId: string): string {
  return `[${testId}]`;
}

export interface GenerationManifest {
  schemaVersion: typeof GENERATION_SCHEMA_VERSION;
  generatedAt: string;
  language: Language;
  tests: { testId: string; file: string; title: string }[]; // file is project-relative
  excluded: { testId: string; reason: string }[];
  sharedFilesChanged: string[]; // fixtures/pages/utils touched, project-relative
}

export function validateGenerationManifest(v: unknown, ctx: { rootDir: string; specs: TestSpecDocument | null }): string[] {
  if (typeof v !== 'object' || v === null) return ['generation manifest must be an object'];
  const g = v as Partial<GenerationManifest>;
  const issues: string[] = [];
  if (g.schemaVersion !== GENERATION_SCHEMA_VERSION) issues.push('unsupported schemaVersion');
  if (g.language !== 'typescript' && g.language !== 'javascript') issues.push('language must be typescript or javascript');
  if (!Array.isArray(g.tests) || !Array.isArray(g.excluded) || !Array.isArray(g.sharedFilesChanged)) {
    return [...issues, 'tests, excluded and sharedFilesChanged must be arrays'];
  }
  if (g.tests.length === 0) issues.push('no tests were generated');
  const ext = g.language ? specFileExtension(g.language) : '.spec.ts';
  const sources = new Map<string, string>();
  for (const t of g.tests) {
    const file = String(t.file ?? '');
    if (isAbsoluteOrEscaping(file) || !file.startsWith(`${GENERATED_TESTS_DIR}/`)) {
      issues.push(`${t.testId}: "${file}" is outside ${GENERATED_TESTS_DIR}/ (generated tests never go elsewhere)`);
      continue;
    }
    if (!file.endsWith(ext)) issues.push(`${t.testId}: "${file}" must end with ${ext}`);
    const abs = path.join(ctx.rootDir, file);
    if (!existsSync(abs)) { issues.push(`${t.testId}: "${file}" does not exist`); continue; }
    if (!sources.has(file)) sources.set(file, readFileSync(abs, 'utf8'));
    if (!sources.get(file)!.includes(testTitlePrefix(t.testId))) {
      issues.push(`${t.testId}: "${file}" has no test titled "${testTitlePrefix(t.testId)} ..."`);
    }
    if (typeof t.title !== 'string' || !t.title.startsWith(testTitlePrefix(t.testId))) {
      issues.push(`${t.testId}: title must start with "${testTitlePrefix(t.testId)}"`);
    }
  }
  if (ctx.specs) {
    const generated = new Set(g.tests.map((t) => t.testId));
    const excluded = new Set(g.excluded.map((e) => e.testId));
    for (const s of ctx.specs.specs) {
      if (s.status === 'needs_clarification' && generated.has(s.id)) {
        issues.push(`${s.id} needs clarification and must not be generated`);
      }
      if (s.status === 'ready' && !generated.has(s.id) && !excluded.has(s.id)) {
        issues.push(`ready spec ${s.id} is neither generated nor excluded with a reason`);
      }
    }
    const known = new Set(ctx.specs.specs.map((s) => s.id));
    for (const id of generated) if (!known.has(id)) issues.push(`generated test ${id} has no source spec`);
  }
  for (const e of g.excluded) {
    if (typeof e.reason !== 'string' || e.reason.trim() === '') issues.push(`excluded ${e.testId} needs a reason`);
  }
  return issues;
}
