// Parses supplied test cases (Markdown, CSV) into normalized TestSpecs.
// Wording is preserved verbatim; nothing is inferred. Gaps are flagged as ambiguities.
// Input formats are documented in docs/test-spec-schema.md.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { sha256File, toPosixRelative } from '../utils/fs.ts';
import {
  TEST_ID_PATTERN, TEST_SPEC_SCHEMA_VERSION, specStatus,
  type Ambiguity, type InputFormat, type SourceFile, type SpecStep, type TestDataRef, type TestSpec, type TestSpecDocument,
} from './test-spec.ts';

export const FORMAT_BY_EXTENSION: Record<string, InputFormat> = { '.md': 'markdown', '.markdown': 'markdown', '.csv': 'csv' };

export function detectFormat(file: string): InputFormat | null {
  return FORMAT_BY_EXTENSION[path.extname(file).toLowerCase()] ?? null;
}

// A case before IDs, statuses and ambiguity checks are finalized.
interface DraftCase {
  originalId: string | null;
  title: string;
  line: number;
  suite: string | null;
  priority: string | null;
  tags: string[];
  preconditions: string[];
  steps: { action: string; expected: string | null }[];
  expectedResults: string[];
  testData: TestDataRef[];
}

function draft(line: number, suite: string | null, originalId: string | null, title: string): DraftCase {
  return { originalId, title, line, suite, priority: null, tags: [], preconditions: [], steps: [], expectedResults: [], testData: [] };
}

const ID_TITLE = /^\[?([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9][A-Za-z0-9_-]*)\]?\s*(?:[:–—-]\s*|\s+)(.+)$/;
const ENV_REF = /^(?:env:\s*|\$\{)([A-Z_][A-Z0-9_]*)\}?$/;
const SECRET_NAME = /pass(word)?|pwd|secret|token|api[_-]?key|credential/i;
const VAGUE = /\b(?:works?|working|functions?)\s+(?:correctly|properly|fine|as expected)\b|^as expected$|\bshould be (?:ok|fine|correct)\b/i;
const STEP_EXPECTED = /\s*(?:->|=>|→|\|)\s*expected(?:\s+result)?\s*:\s*/i;

function splitIdTitle(text: string): { id: string | null; title: string } {
  const m = ID_TITLE.exec(text.trim());
  if (m && TEST_ID_PATTERN.test(m[1]!)) return { id: m[1]!, title: m[2]!.trim() };
  return { id: null, title: text.trim() };
}

export function parseDataItem(text: string): TestDataRef | null {
  const m = /^([^:=]+?)\s*[:=]\s*(.*)$/.exec(text.trim());
  if (!m) return null;
  const name = m[1]!.trim();
  const raw = m[2]!.trim().replace(/^["'`](.*)["'`]$/, '$1');
  const env = ENV_REF.exec(raw);
  if (env) return { name, value: null, envVar: env[1]!, declaredLiteral: false };
  // "literal:" declares a deliberately non-secret value (e.g. a wrong password for a negative test).
  const literal = /^literal:\s*(.*)$/.exec(raw);
  return { name, value: literal ? literal[1]! : raw, envVar: null, declaredLiteral: literal !== null };
}

function splitAction(text: string): { action: string; expected: string | null } {
  const parts = text.split(STEP_EXPECTED);
  if (parts.length >= 2) return { action: parts[0]!.trim(), expected: parts.slice(1).join(' ').trim() || null };
  return { action: text.trim(), expected: null };
}

// ---------- Markdown ----------

type Section = 'none' | 'preconditions' | 'data' | 'steps' | 'expected';

function sectionOf(label: string): Section | null {
  const l = label.toLowerCase().replace(/[*_:]/g, '').trim();
  if (/^(pre-?conditions?|pre-?requisites?)$/.test(l)) return 'preconditions';
  if (/^(test )?data$/.test(l)) return 'data';
  if (/^(test )?steps?$/.test(l)) return 'steps';
  if (/^expected( results?| outcomes?)?$/.test(l)) return 'expected';
  return null;
}

const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

export function parseMarkdown(text: string): DraftCase[] {
  const cases: DraftCase[] = [];
  let suite: string | null = null;
  let cur: DraftCase | null = null;
  let section: Section = 'none';
  let lastIndent = 0;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);

  lines.forEach((rawLine, i) => {
    const lineNo = i + 1;
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim() === '') return;

    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1) { suite = h1[1]!.trim(); cur = null; return; }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      const { id, title } = splitIdTitle(h2[1]!);
      cur = draft(lineNo, suite, id, title);
      cases.push(cur);
      section = 'none';
      return;
    }
    if (!cur) return; // prose outside any test case
    const c: DraftCase = cur;

    const h3 = /^#{3,6}\s+(.+)$/.exec(line);
    if (h3) { section = sectionOf(h3[1]!) ?? 'none'; return; }

    // "Steps:" style labels, optionally with inline content ("Expected Result: X")
    const label = /^\s*\**([A-Za-z][A-Za-z -]*?)\**\s*:\s*\**\s*(.*)$/.exec(line);
    if (label && !LIST_ITEM.test(line)) {
      const key = label[1]!.toLowerCase().trim();
      const value = label[2]!.trim();
      if (key === 'priority') { c.priority = value || null; return; }
      if (key === 'tags' || key === 'labels') { c.tags = splitList(value); return; }
      const s = sectionOf(key);
      if (s) {
        section = s;
        if (value) addToSection(c, s, value);
        return;
      }
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const indent = item[1]!.length;
      const content = item[2]!.trim();
      const nestedExpected = /^expected(?:\s+result)?\s*:\s*(.*)$/i.exec(content);
      if (section === 'steps' && indent > lastIndent && nestedExpected && c.steps.length > 0) {
        const step = c.steps[c.steps.length - 1]!;
        step.expected = step.expected ? `${step.expected} ${nestedExpected[1]!.trim()}` : nestedExpected[1]!.trim();
        return;
      }
      lastIndent = indent;
      addToSection(c, section, content);
      return;
    }

    // Plain continuation text: append to the previous item in the section.
    appendContinuation(c, section, line.trim());
  });
  return cases;
}

function addToSection(c: DraftCase, s: Section, content: string): void {
  if (s === 'preconditions') c.preconditions.push(content);
  else if (s === 'expected') c.expectedResults.push(content);
  else if (s === 'steps') c.steps.push(splitAction(content));
  else if (s === 'data') {
    const d = parseDataItem(content);
    if (d) c.testData.push(d);
  }
}

function appendContinuation(c: DraftCase, s: Section, text: string): void {
  const join = (a: string) => `${a} ${text}`;
  if (s === 'preconditions' && c.preconditions.length) c.preconditions[c.preconditions.length - 1] = join(c.preconditions.at(-1)!);
  else if (s === 'expected') {
    if (c.expectedResults.length) c.expectedResults[c.expectedResults.length - 1] = join(c.expectedResults.at(-1)!);
    else c.expectedResults.push(text);
  } else if (s === 'steps' && c.steps.length) {
    const st = c.steps.at(-1)!;
    if (st.expected) st.expected = join(st.expected);
    else st.action = join(st.action);
  }
}

function splitList(v: string): string[] {
  return v.split(/[,;]/).map((s) => s.trim().replace(/^@/, '')).filter(Boolean);
}

// ---------- CSV ----------

export function parseCsvRecords(text: string): { line: number; cells: string[] }[] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else { if (ch === '\n') line++; cell += ch; }
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { cells.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      cells.push(cell);
      if (cells.some((c) => c.trim() !== '')) records.push({ line: recordLine, cells });
      cells = []; cell = '';
      line++;
      recordLine = line;
    } else cell += ch;
  }
  if (quoted) throw new Error(`unterminated quoted field starting on line ${recordLine}`);
  cells.push(cell);
  if (cells.some((c) => c.trim() !== '')) records.push({ line: recordLine, cells });
  return records;
}

const COLUMN_ALIASES: Record<string, readonly string[]> = {
  id: ['id', 'test id', 'test case id', 'tc id', 'case id', 'testcase id'],
  title: ['title', 'test case title', 'test case name', 'test case', 'testcase', 'name', 'summary', 'scenario', 'test scenario'],
  preconditions: ['preconditions', 'precondition', 'pre-conditions', 'pre-condition', 'prerequisites', 'pre-requisites'],
  steps: ['steps', 'test steps', 'step', 'test step', 'action', 'actions', 'step description'],
  expected: ['expected result', 'expected results', 'expected', 'expected outcome', 'expected behaviour', 'expected behavior'],
  data: ['test data', 'data'],
  priority: ['priority'],
  tags: ['tags', 'labels', 'tag'],
};

export function mapColumns(header: string[]): { columns: Partial<Record<keyof typeof COLUMN_ALIASES, number>>; errors: string[] } {
  const norm = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '));
  const columns: Partial<Record<string, number>> = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = norm.findIndex((h) => aliases.includes(h));
    if (idx >= 0) columns[key] = idx;
  }
  const errors: string[] = [];
  if (columns.title === undefined && columns.id === undefined) errors.push('CSV needs a test case ID or title column');
  if (columns.steps === undefined) errors.push('CSV needs a steps column');
  if (columns.expected === undefined) errors.push('CSV needs an expected result column');
  if (errors.length) errors.push(`found columns: ${header.map((h) => JSON.stringify(h.trim())).join(', ')}`);
  return { columns, errors };
}

const NUMBERED = /^\s*(?:\d+[.)]|[-*•])\s*/;

function cellLines(v: string): string[] {
  return v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export function parseCsv(text: string): DraftCase[] {
  const records = parseCsvRecords(text);
  if (records.length === 0) throw new Error('CSV is empty');
  const { columns, errors } = mapColumns(records[0]!.cells);
  if (errors.length) throw new Error(errors.join('; '));
  const get = (cells: string[], key: keyof typeof COLUMN_ALIASES) => {
    const i = columns[key];
    return i === undefined ? '' : (cells[i] ?? '').trim();
  };

  const cases: DraftCase[] = [];
  let cur: DraftCase | null = null;
  for (const { line, cells } of records.slice(1)) {
    const id = get(cells, 'id');
    const title = get(cells, 'title');
    if (id || title || !cur) {
      cur = draft(line, null, id || null, title || id || `Row ${line}`);
      cur.priority = get(cells, 'priority') || null;
      cur.tags = splitList(get(cells, 'tags'));
      cur.preconditions = cellLines(get(cells, 'preconditions')).map((l) => l.replace(NUMBERED, ''));
      for (const d of get(cells, 'data').split(/\r?\n|;/)) {
        const ref = d.trim() ? parseDataItem(d) : null;
        if (ref) cur.testData.push(ref);
      }
      cases.push(cur);
    }
    addCsvSteps(cur, get(cells, 'steps'), get(cells, 'expected'));
  }
  return cases;
}

// One row may hold one step (multi-row cases) or a numbered list of steps (single-row cases).
function addCsvSteps(c: DraftCase, stepsCell: string, expectedCell: string): void {
  const steps = cellLines(stepsCell).map((l) => l.replace(NUMBERED, ''));
  const expected = cellLines(expectedCell).map((l) => l.replace(NUMBERED, ''));
  if (steps.length === 0) {
    if (expected.length) c.expectedResults.push(...expected);
    return;
  }
  if (steps.length === 1) {
    c.steps.push({ action: steps[0]!, expected: expected.length ? expected.join(' ') : null });
    return;
  }
  if (expected.length === steps.length) {
    steps.forEach((s, i) => c.steps.push({ action: s, expected: expected[i]! }));
    return;
  }
  // Counts don't line up: keep expected results at case level rather than guess a pairing.
  for (const s of steps) c.steps.push({ action: s, expected: null });
  c.expectedResults.push(...expected);
}

// ---------- Normalization ----------

function autoId(sourcePath: string, title: string): string {
  return `AUTO-${createHash('sha256').update(`${sourcePath}\n${title.trim().toLowerCase()}`).digest('hex').slice(0, 8)}`;
}

function checkCase(c: DraftCase): Ambiguity[] {
  const out: Ambiguity[] = [];
  if (c.steps.length === 0) out.push({ kind: 'missing_steps', message: 'no steps found', stepIndex: null });
  c.steps.forEach((s, i) => {
    if (!s.action) out.push({ kind: 'empty_step', message: `step ${i + 1} has no action`, stepIndex: i + 1 });
  });
  const anyExpected = c.expectedResults.length > 0 || c.steps.some((s) => s.expected);
  if (!anyExpected) out.push({ kind: 'missing_expected_result', message: 'no expected result is stated; it will not be invented', stepIndex: null });
  const vague = [...c.expectedResults, ...c.steps.map((s) => s.expected ?? '')].filter((e) => e && VAGUE.test(e));
  for (const v of vague) out.push({ kind: 'vague_expected_result', message: `"${v}" is not specific enough to assert`, stepIndex: null });
  const defined = new Set(c.testData.map((d) => d.name.toLowerCase()));
  c.steps.forEach((s, i) => {
    for (const m of `${s.action} ${s.expected ?? ''}`.matchAll(/\{([A-Za-z][\w .-]*)\}/g)) {
      if (!defined.has(m[1]!.toLowerCase())) {
        out.push({ kind: 'undefined_data_reference', message: `step ${i + 1} references {${m[1]}} but Test Data does not define it`, stepIndex: i + 1 });
      }
    }
  });
  for (const d of c.testData) {
    if (d.value !== null && d.value !== '' && !d.declaredLiteral && SECRET_NAME.test(d.name)) {
      out.push({ kind: 'possible_secret_literal', message: `test data "${d.name}" looks like a credential; use env:VAR_NAME instead of a literal`, stepIndex: null });
    }
  }
  return out;
}

export function normalizeCases(drafts: DraftCase[], sourcePath: string, seen: Map<string, TestSpec[]>): TestSpec[] {
  return drafts.map((c) => {
    const ambiguities = checkCase(c);
    const key = c.originalId ?? autoId(sourcePath, c.title);
    let id = key;
    const prior = seen.get(key);
    if (prior) {
      // Both cases are flagged; the later one gets a suffixed ID so IDs stay unique.
      const msg = `ID "${key}" is used by more than one test case`;
      for (const p of prior) {
        if (!p.ambiguities.some((a) => a.kind === 'duplicate_id')) {
          p.ambiguities.push({ kind: 'duplicate_id', message: msg, stepIndex: null });
          p.status = specStatus(p.ambiguities);
        }
      }
      ambiguities.push({ kind: 'duplicate_id', message: msg, stepIndex: null });
      id = `${key}-dup${prior.length + 1}`;
    }
    const steps: SpecStep[] = c.steps.map((s, i) => ({ index: i + 1, action: s.action, expected: s.expected }));
    const spec: TestSpec = {
      id,
      title: c.title,
      source: { path: sourcePath, line: c.line, originalId: c.originalId },
      suite: c.suite,
      priority: c.priority,
      tags: c.tags,
      preconditions: c.preconditions,
      steps,
      expectedResults: c.expectedResults,
      testData: c.testData,
      ambiguities,
      status: specStatus(ambiguities),
    };
    seen.set(key, [...(prior ?? []), spec]);
    return spec;
  });
}

export interface ParseError {
  path: string;
  message: string;
}

// Input paths are relative to baseDir (the dependencies/ folder).
export function listInputFiles(baseDir: string, inputPath: string): string[] {
  const abs = path.resolve(baseDir, inputPath);
  const st = statSync(abs);
  if (st.isFile()) return [abs];
  return readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('.'))
    .map((d) => path.join(d.parentPath, d.name))
    .sort();
}

export function parseInputs(baseDir: string, files: string[], now: Date = new Date()): { document: TestSpecDocument; errors: ParseError[]; unsupported: string[] } {
  const sources: SourceFile[] = [];
  const specs: TestSpec[] = [];
  const errors: ParseError[] = [];
  const unsupported: string[] = [];
  const seen = new Map<string, TestSpec[]>();
  for (const abs of files) {
    const rel = toPosixRelative(baseDir, abs);
    const format = detectFormat(abs);
    if (!format) { unsupported.push(rel); continue; }
    try {
      const text = readFileSync(abs, 'utf8');
      const drafts = format === 'markdown' ? parseMarkdown(text) : parseCsv(text);
      if (drafts.length === 0) {
        errors.push({ path: rel, message: format === 'markdown' ? 'no test cases found (each case needs a "## <ID>: <title>" heading)' : 'no data rows' });
        continue;
      }
      sources.push({ path: rel, sha256: sha256File(abs), format });
      specs.push(...normalizeCases(drafts, rel, seen));
    } catch (err) {
      errors.push({ path: rel, message: (err as Error).message });
    }
  }
  return {
    document: { schemaVersion: TEST_SPEC_SCHEMA_VERSION, generatedAt: now.toISOString(), sources, specs },
    errors,
    unsupported,
  };
}
