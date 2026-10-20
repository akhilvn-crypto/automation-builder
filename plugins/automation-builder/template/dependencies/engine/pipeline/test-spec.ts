// Normalized test specification: the contract between test analysis and generation.
// Written to dependencies/runs/<run-id>/test-specs.json. Documented in docs/test-spec-schema.md.

export const TEST_SPEC_SCHEMA_VERSION = 2;

export const INPUT_FORMATS = ['markdown', 'csv', 'xlsx'] as const;
export type InputFormat = (typeof INPUT_FORMATS)[number];

export const SPEC_STATUSES = ['ready', 'needs_clarification'] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];

export const AMBIGUITY_KINDS = [
  'missing_expected_result', // no expected result anywhere in the case
  'missing_steps',
  'empty_step',
  'duplicate_id', // the same ID appears more than once in the input
  'undefined_data_reference', // step uses {name} that the Test Data section does not define
  'possible_secret_literal', // a credential-looking literal; must become an env var reference
  'vague_expected_result', // e.g. "works correctly" — not verifiable as written
] as const;
export type AmbiguityKind = (typeof AMBIGUITY_KINDS)[number];

// Kinds that make a case unusable for generation until a human clarifies it.
export const BLOCKING_AMBIGUITIES: readonly AmbiguityKind[] = [
  'missing_expected_result', 'missing_steps', 'empty_step', 'duplicate_id',
  'undefined_data_reference', 'possible_secret_literal',
];

export interface SourceRef {
  path: string; // relative to dependencies/, posix
  line: number; // 1-based line (markdown), CSV record line or spreadsheet row
  originalId: string | null; // ID as written in the source, if any
  sheet: string | null; // worksheet name for .xlsx sources, else null
}

export interface SpecStep {
  index: number; // 1-based
  action: string; // original wording
  expected: string | null; // step-level expected result, original wording
}

export interface TestDataRef {
  name: string;
  // Exactly one of: a literal non-secret value, or the NAME of an env var holding the value.
  value: string | null;
  envVar: string | null;
  declaredLiteral: boolean; // written as "literal:<value>" — explicitly confirmed non-secret
}

export interface Ambiguity {
  kind: AmbiguityKind;
  message: string;
  stepIndex: number | null;
}

export interface TestSpec {
  id: string; // stable ID used in test titles, results and healing records
  title: string;
  source: SourceRef;
  suite: string | null; // the Markdown "# heading" the case sits under, else null (informational)
  module: string; // the module (feature area) the case belongs to; one test file is generated per module
  moduleSlug: string; // file-name form of `module`; always slugify(module)
  priority: string | null;
  tags: string[];
  preconditions: string[];
  steps: SpecStep[];
  expectedResults: string[]; // case-level expected results, original wording
  testData: TestDataRef[];
  ambiguities: Ambiguity[];
  status: SpecStatus;
}

export interface SourceFile {
  path: string;
  sha256: string;
  format: InputFormat;
}

export interface TestSpecDocument {
  schemaVersion: typeof TEST_SPEC_SCHEMA_VERSION;
  generatedAt: string;
  sources: SourceFile[];
  specs: TestSpec[];
}

// File-name form of a module name: "Create Project" -> "create-project". Never empty.
export function slugify(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'general';
}

export const TEST_ID_PATTERN = /^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]*$/;

export function specStatus(ambiguities: Ambiguity[]): SpecStatus {
  return ambiguities.some((a) => BLOCKING_AMBIGUITIES.includes(a.kind)) ? 'needs_clarification' : 'ready';
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

export function validateTestSpecDocument(v: unknown): string[] {
  if (!isObj(v)) return ['test-specs must be a JSON object'];
  const issues: string[] = [];
  if (v.schemaVersion !== TEST_SPEC_SCHEMA_VERSION) issues.push(`unsupported schemaVersion ${JSON.stringify(v.schemaVersion)}`);
  if (typeof v.generatedAt !== 'string' || Number.isNaN(Date.parse(v.generatedAt))) issues.push('generatedAt must be a timestamp');
  if (!Array.isArray(v.sources) || v.sources.length === 0) issues.push('sources must list at least one input file');
  else {
    for (const s of v.sources) {
      if (!isObj(s) || typeof s.path !== 'string' || typeof s.sha256 !== 'string' || !(INPUT_FORMATS as readonly unknown[]).includes(s.format)) {
        issues.push(`invalid source entry ${JSON.stringify(s)}`);
      }
    }
  }
  if (!Array.isArray(v.specs)) return [...issues, 'specs must be an array'];
  if (v.specs.length === 0) issues.push('specs is empty: no test cases were found in the input');
  const ids = new Set<string>();
  v.specs.forEach((s, i) => {
    const at = `specs[${i}]`;
    if (!isObj(s)) return void issues.push(`${at} must be an object`);
    if (typeof s.id !== 'string' || !TEST_ID_PATTERN.test(s.id)) issues.push(`${at}.id ${JSON.stringify(s.id)} is not a valid test ID`);
    else if (ids.has(s.id)) issues.push(`${at}.id "${s.id}" is not unique`);
    else ids.add(s.id);
    if (typeof s.title !== 'string' || s.title.trim() === '') issues.push(`${at}.title is required`);
    if (!isObj(s.source) || typeof s.source.path !== 'string' || !Number.isInteger(s.source.line)) issues.push(`${at}.source must have path and line`);
    if (typeof s.module !== 'string' || s.module.trim() === '') issues.push(`${at}.module is required`);
    else if (s.moduleSlug !== slugify(s.module)) issues.push(`${at}.moduleSlug must be "${slugify(s.module)}" for module ${JSON.stringify(s.module)}`);
    if (!isStrArray(s.tags) || !isStrArray(s.preconditions) || !isStrArray(s.expectedResults)) {
      issues.push(`${at}: tags, preconditions and expectedResults must be string arrays`);
    }
    if (!Array.isArray(s.steps)) issues.push(`${at}.steps must be an array`);
    else s.steps.forEach((st, j) => {
      if (!isObj(st) || st.index !== j + 1 || typeof st.action !== 'string' || !(st.expected === null || typeof st.expected === 'string')) {
        issues.push(`${at}.steps[${j}] must be {index: ${j + 1}, action, expected|null}`);
      }
    });
    if (!Array.isArray(s.testData)) issues.push(`${at}.testData must be an array`);
    else for (const d of s.testData) {
      if (!isObj(d) || typeof d.name !== 'string') { issues.push(`${at}.testData entry needs a name`); continue; }
      const hasValue = typeof d.value === 'string';
      const hasEnv = typeof d.envVar === 'string';
      if (hasValue === hasEnv) issues.push(`${at}.testData "${d.name}" must have exactly one of value or envVar`);
      if (hasEnv && !ENV_VAR_NAME.test(d.envVar as string)) issues.push(`${at}.testData "${d.name}" envVar must be an env var NAME`);
    }
    if (!Array.isArray(s.ambiguities)) issues.push(`${at}.ambiguities must be an array`);
    else {
      for (const a of s.ambiguities) {
        if (!isObj(a) || !(AMBIGUITY_KINDS as readonly unknown[]).includes(a.kind)) issues.push(`${at} has an invalid ambiguity ${JSON.stringify(a)}`);
      }
      // status must agree with the ambiguities, so a blocked case can't be marked ready by hand
      const expected = specStatus(s.ambiguities as Ambiguity[]);
      if (s.status !== expected) issues.push(`${at}.status must be "${expected}" given its ambiguities (got ${JSON.stringify(s.status)})`);
    }
  });
  return issues;
}

export function readySpecs(doc: TestSpecDocument): TestSpec[] {
  return doc.specs.filter((s) => s.status === 'ready');
}
