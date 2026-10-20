// Generation manifest written by the playwright-generator agent: dependencies/runs/<run-id>/generation-manifest.json.
// Maps every ready spec to a generated test (or an explicit exclusion) for traceability.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isAbsoluteOrEscaping, type Language } from '../config/schema.ts';
import type { TestSpecDocument } from './test-spec.ts';

export const GENERATION_SCHEMA_VERSION = 1;
// Generated and handwritten tests share tests/. Ownership is a header marker, not a folder: the pipeline writes,
// regenerates and heals only files that carry it. Deleting the line hands the file over to the user.
export const TESTS_DIR = 'tests';
export const GENERATED_MARKER = '@automation-builder:generated';
export const GENERATED_HEADER = `// ${GENERATED_MARKER} — owned by the pipeline (regenerated and healed by it). Delete this line to take ownership of the file.`;

export function isPipelineOwned(source: string): boolean {
  return source.split(/\r?\n/, 5).some((l) => l.includes(GENERATED_MARKER));
}
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
  tests: { testId: string; file: string; title: string }[]; // file is relative to automation/
  excluded: { testId: string; reason: string }[];
  sharedFilesChanged: string[]; // fixtures/pages/helpers/auth touched, relative to automation/
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
    if (isAbsoluteOrEscaping(file) || !file.startsWith(`${TESTS_DIR}/`)) {
      issues.push(`${t.testId}: "${file}" is outside ${TESTS_DIR}/ (generated tests never go elsewhere)`);
      continue;
    }
    if (!file.endsWith(ext)) issues.push(`${t.testId}: "${file}" must end with ${ext}`);
    const abs = path.join(ctx.rootDir, file);
    if (!existsSync(abs)) { issues.push(`${t.testId}: "${file}" does not exist`); continue; }
    if (!sources.has(file)) {
      sources.set(file, readFileSync(abs, 'utf8'));
      if (!isPipelineOwned(sources.get(file)!)) {
        issues.push(`${t.testId}: "${file}" lacks the "${GENERATED_MARKER}" header; the pipeline may only write files it owns (never overwrite a handwritten test: pick another file name)`);
      }
    }
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
