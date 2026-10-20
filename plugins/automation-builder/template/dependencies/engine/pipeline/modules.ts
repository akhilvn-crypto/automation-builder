// Modules: the unit generated tests are organised by. Every spec belongs to one module (a feature area such as "Login" or
// "Create Project"), and the generator writes one test file per module instead of one file for everything.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Language } from '../config/schema.ts';
import { TESTS_DIR, isPipelineOwned, specFileExtension } from './generation.ts';
import type { TestSpec, TestSpecDocument } from './test-spec.ts';

export interface ModulePlan {
  module: string; // display name, used for test.describe(...)
  moduleSlug: string;
  file: string; // the one test file for this module, relative to automation/
  fileState: 'new' | 'pipeline-owned' | 'handwritten-renamed'; // handwritten-renamed: <slug>.spec.* is a handwritten file, so another name is used
  ready: string[]; // spec IDs to generate
  needsClarification: string[]; // spec IDs that must not be generated
  sources: string[]; // input files (with sheet) the module's cases came from
}

export function groupByModule(specs: TestSpec[]): Map<string, TestSpec[]> {
  const groups = new Map<string, TestSpec[]>();
  for (const s of specs) {
    const key = s.moduleSlug;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return groups;
}

// One test file per module. A file name already used by a handwritten test is never reused: the module gets
// "<slug>.generated.spec.<ext>" (then -2, -3, ...) so the pipeline never overwrites something it does not own.
export function planModules(doc: TestSpecDocument, language: Language, rootDir: string): ModulePlan[] {
  const ext = specFileExtension(language);
  const plans: ModulePlan[] = [];
  for (const [slug, specs] of groupByModule(doc.specs)) {
    let file = `${TESTS_DIR}/${slug}${ext}`;
    let owned = false;
    let renamed = false;
    for (let n = 1; existsSync(path.join(rootDir, file)); n++) {
      if (isPipelineOwned(readFileSync(path.join(rootDir, file), 'utf8'))) { owned = true; break; }
      renamed = true;
      file = `${TESTS_DIR}/${slug}.generated${n === 1 ? '' : `-${n}`}${ext}`;
    }
    plans.push({
      module: specs[0]!.module,
      moduleSlug: slug,
      file,
      fileState: owned ? 'pipeline-owned' : renamed ? 'handwritten-renamed' : 'new',
      ready: specs.filter((s) => s.status === 'ready').map((s) => s.id),
      needsClarification: specs.filter((s) => s.status === 'needs_clarification').map((s) => s.id),
      sources: [...new Set(specs.map((s) => (s.source.sheet ? `${s.source.path} [${s.source.sheet}]` : s.source.path)))],
    });
  }
  return plans;
}

// ---------- canonical Markdown (the pipeline's own input format) ----------

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

function renderSpec(s: TestSpec): string[] {
  const out = [`## ${s.id}: ${oneLine(s.title)}`];
  if (s.priority) out.push(`Priority: ${oneLine(s.priority)}`);
  if (s.tags.length) out.push(`Tags: ${s.tags.join(', ')}`);
  if (s.preconditions.length) out.push('### Preconditions', ...s.preconditions.map((p) => `- ${oneLine(p)}`));
  if (s.testData.length) {
    out.push('### Test Data');
    for (const d of s.testData) out.push(`- ${d.name}: ${d.envVar !== null ? `env:${d.envVar}` : d.declaredLiteral ? `literal:${d.value}` : d.value}`);
  }
  if (s.steps.length) {
    out.push('### Steps');
    for (const st of s.steps) out.push(`${st.index}. ${oneLine(st.action)}${st.expected ? ` -> Expected: ${oneLine(st.expected)}` : ''}`);
  }
  if (s.expectedResults.length) out.push('### Expected Results', ...s.expectedResults.map((e) => `- ${oneLine(e)}`));
  return out;
}

// One module as a Markdown file in the format `specs parse` reads natively. Built from the parsed specs, so credentials
// appear as env:VAR references (never values) and inline emails as {placeholders}.
export function renderModuleMarkdown(module: string, specs: TestSpec[]): string {
  const lines = [`# ${oneLine(module)}`, ''];
  for (const s of specs) lines.push(...renderSpec(s), '');
  return lines.join('\n');
}

// One case as its own Markdown file (the module heading is kept so the case lands in the same module when it is read back).
export function renderCaseMarkdown(spec: TestSpec): string {
  return [`# ${oneLine(spec.module)}`, '', ...renderSpec(spec), ''].join('\n');
}

export interface NormalizedFile { module: string; moduleSlug: string; file: string; cases: number }

// Writes <dir>/<slug>.md for every module. The run keeps these as the record of how the original input was understood;
// copy one into the input folder to continue in the canonical format.
export function writeNormalizedInput(dir: string, doc: TestSpecDocument): NormalizedFile[] {
  rmSync(dir, { recursive: true, force: true }); // a re-parse must not leave files of modules that no longer exist
  mkdirSync(dir, { recursive: true });
  return [...groupByModule(doc.specs)].map(([slug, specs]) => {
    const file = `${slug}.md`;
    writeFileSync(path.join(dir, file), renderModuleMarkdown(specs[0]!.module, specs));
    return { module: specs[0]!.module, moduleSlug: slug, file, cases: specs.length };
  });
}
