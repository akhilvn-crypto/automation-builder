// Parses supplied test cases (Markdown, CSV, Excel .xlsx) into normalized TestSpecs.
// Wording is preserved verbatim; nothing is inferred. Gaps are flagged as ambiguities.
// Input formats are documented in docs/test-spec-schema.md.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { sha256File, toPosixRelative } from '../utils/fs.ts';
import { readXlsx } from '../utils/xlsx.ts';
import { quoteEnvValue } from './env-file.ts';
import {
  mappingFor, reportOf, resolveTable, type Field, type InputMappings, type ResolvedTable, type TableMapping, type TableReport, type TableRow,
} from './input-table.ts';
import {
  TEST_ID_PATTERN, TEST_SPEC_SCHEMA_VERSION, slugify, specStatus,
  type Ambiguity, type InputFormat, type SourceFile, type SpecStep, type TestDataRef, type TestSpec, type TestSpecDocument,
} from './test-spec.ts';

export const FORMAT_BY_EXTENSION: Record<string, InputFormat> = { '.md': 'markdown', '.markdown': 'markdown', '.csv': 'csv', '.tsv': 'csv', '.xlsx': 'xlsx' };

// Spreadsheet formats the engine cannot read, with what to do instead.
export const CONVERT_FIRST: Record<string, string> = {
  '.xls': 'legacy Excel format: open it in Excel and save as .xlsx (or export to .csv)',
  '.xlsm': 'macro-enabled workbook: save a copy as .xlsx (or export to .csv)',
  '.ods': 'OpenDocument spreadsheet: save as .xlsx or export to .csv',
  '.numbers': 'Numbers spreadsheet: export to .xlsx or .csv',
};

export function detectFormat(file: string): InputFormat | null {
  return FORMAT_BY_EXTENSION[path.extname(file).toLowerCase()] ?? null;
}

// A case before IDs, statuses and ambiguity checks are finalized.
interface DraftCase {
  originalId: string | null;
  title: string;
  line: number;
  suite: string | null;
  module: string | null; // explicit module from a column, sheet or mapping; Markdown cases use their "# heading" (suite)
  sheet: string | null;
  priority: string | null;
  tags: string[];
  preconditions: string[];
  steps: { action: string; expected: string | null }[];
  expectedResults: string[];
  testData: TestDataRef[];
}

function draft(line: number, suite: string | null, originalId: string | null, title: string): DraftCase {
  return { originalId, title, line, suite, module: null, sheet: null, priority: null, tags: [], preconditions: [], steps: [], expectedResults: [], testData: [] };
}

const ID_TITLE = /^\[?([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9][A-Za-z0-9_-]*)\]?\s*(?:[:–—-]\s*|\s+)(.+)$/;
const ENV_REF = /^(?:env:\s*|\$\{)([A-Z_][A-Z0-9_]*)\}?$/;
const SECRET_NAME = /passw(?:or)?d|pass(?:code|phrase)|\bpass\b|pwd|secret|token|api[_-]?key|credential/i;
const IDENTITY_NAME = /e-?mail|user[ _-]?(?:name|id)|^user$|^login$|^account$/i;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INLINE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
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

// A literal that is a credential or account detail: a password/token-style field, a username/email field, or any email address.
// Written as "literal:<value>" it is treated as deliberately fake and left alone (e.g. a wrong password for a negative test).
export function isCredentialData(d: TestDataRef): boolean {
  if (d.envVar !== null || d.declaredLiteral || d.value === null || d.value === '') return false;
  return SECRET_NAME.test(d.name) || IDENTITY_NAME.test(d.name) || EMAIL_VALUE.test(d.value);
}

export interface DetectedCredential {
  envVar: string;
  value: string; // in memory only: handed to the caller that writes .env, never stored in test-specs.json
}

// Picks env var names for detected values: TEST_<DATA_NAME>, then TEST_<DATA_NAME>_<CASE_ID> when two cases need the same
// name for different values. Names the user wrote as env:VAR are reserved, so a detected value never lands in them.
class EnvAllocator {
  readonly values = new Map<string, string>();
  private readonly reserved: Set<string>;
  constructor(reserved: Iterable<string>) { this.reserved = new Set(reserved); }

  assign(dataName: string, value: string, caseKey: string): string {
    const token = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const base = `TEST_${token(dataName).replace(/^TEST_/, '') || 'VALUE'}`;
    const suffix = token(caseKey);
    for (let n = 0; ; n++) {
      const name = n === 0 ? base : n === 1 ? `${base}_${suffix}` : `${base}_${suffix}_${n}`;
      if (this.reserved.has(name)) continue;
      const held = this.values.get(name);
      if (held === undefined) { this.values.set(name, value); return name; }
      if (held === value) return name;
    }
  }
}

// Replaces credential literals with env var references, and inline email addresses in steps with a {name} placeholder
// backed by a new Test Data entry. Values that cannot be stored in a .env file are left for checkCase to flag.
function extractCredentials(c: DraftCase, caseKey: string, alloc: EnvAllocator): void {
  const nameOfValue = new Map<string, string>(); // raw value -> data name, so inline repeats reuse the entry
  c.testData = c.testData.map((d) => {
    if (!isCredentialData(d) || quoteEnvValue(d.value!) === null) return d;
    nameOfValue.set(d.value!, d.name);
    return { name: d.name, value: null, envVar: alloc.assign(d.name, d.value!, caseKey), declaredLiteral: false };
  });
  const defined = new Set(c.testData.map((d) => d.name.toLowerCase()));
  const swap = (text: string): string => text.replace(INLINE_EMAIL, (email) => {
    let name = nameOfValue.get(email);
    if (!name) {
      name = 'email';
      for (let n = 2; defined.has(name.toLowerCase()); n++) name = `email ${n}`;
      defined.add(name.toLowerCase());
      nameOfValue.set(email, name);
      c.testData.push({ name, value: null, envVar: alloc.assign(name, email, caseKey), declaredLiteral: false });
    }
    return `{${name}}`;
  });
  c.steps = c.steps.map((s) => ({ action: swap(s.action), expected: s.expected === null ? null : swap(s.expected) }));
  c.expectedResults = c.expectedResults.map(swap);
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

// ---------- Tables (CSV and spreadsheet sheets) ----------

export function parseCsvRecords(text: string): TableRow[] {
  const src = text.replace(/^﻿/, '');
  // The delimiter is the one used most across the first lines (a title block above the header may have none).
  const head = src.split(/\r?\n/).slice(0, 10).join('\n');
  const count = (re: RegExp) => head.match(re)?.length ?? 0;
  const delim = [[',', count(/,/g)], [';', count(/;/g)], ['\t', count(/\t/g)]].sort((a, b) => (b[1] as number) - (a[1] as number))[0]![0] as string;
  const records: TableRow[] = [];
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

// "1. Open", "2) Open", "Step 3: Open", "- Open", "• Open" -> "Open"
const NUMBERED = /^\s*(?:step\s*\d+\s*[-–:.)]?|\d+\s*[.):]|[-*•])\s*/i;

function cellLines(v: string): string[] {
  return v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// Sheet names that say nothing about the feature under test; the file name is used for the module instead.
const GENERIC_SHEET = /^(?:sheet\s*\d*|test\s*cases?|tests?|test\s*suite|cases|data|main)$/i;

export const cleanName = (s: string): string => s.replace(/\s+/g, ' ').trim();

export interface TableParse {
  drafts: DraftCase[];
  moduleFrom: TableReport['moduleFrom'];
  sections: string[];
  titlePrefixes: TableReport['titlePrefixes'];
}

const TITLE_PREFIX = /^(.+?)\s+[-–—]\s+\S/;
const titlePrefixOf = (title: string): string | null => {
  const m = TITLE_PREFIX.exec(title);
  return m ? cleanName(m[1]!) : null;
};

// A heading row inside the table: only its first (ID) cell is filled and it reads as a name, not as an ID ("SMS login
// accessibility", "Blog Subscription/Subscription"; an ID-shaped value such as TC-9 is an incomplete case instead).
function sectionLabel(cells: string[], idColumn: number | undefined): string | null {
  if (idColumn === undefined) return null;
  const filled = cells.map((c, i) => [c.trim(), i] as const).filter(([c]) => c !== '');
  if (filled.length !== 1 || filled[0]![1] !== idColumn) return null;
  const text = filled[0]![0];
  return TEST_ID_PATTERN.test(text) && /\d/.test(text) ? null : cleanName(text);
}

// Turns the rows below a resolved header into cases. A row that starts a case has an ID or a title; a row with neither,
// or one repeating the previous case's ID, continues it (one step per row, as in merged-cell layouts).
export function parseTable(rows: TableRow[], t: ResolvedTable, opts: { sheet: string | null; mapping?: TableMapping }): TableParse {
  const get = (cells: string[], key: Field) => {
    const i = t.columns[key];
    return i === undefined ? '' : (cells[i] ?? '').trim();
  };
  const fixed = opts.mapping?.module ? cleanName(opts.mapping.module) : null;
  const sheetModule = opts.sheet !== null && !GENERIC_SHEET.test(opts.sheet.trim()) ? cleanName(opts.sheet) : null;
  const source = opts.mapping?.moduleSource;
  let moduleFrom: TableReport['moduleFrom'] = null;
  let columnModule: string | null = null;
  let sectionModule: string | null = null;
  const sections: string[] = [];

  const drafts: DraftCase[] = [];
  let cur: DraftCase | null = null;
  for (const { line, cells } of rows.slice(t.headerIndex + 1)) {
    const section = sectionLabel(cells, t.columns.id);
    if (section !== null) {
      sectionModule = section;
      if (!sections.includes(section)) sections.push(section);
      cur = null; // a continuation row never carries over a heading
      continue;
    }
    const id = get(cells, 'id');
    const title = get(cells, 'title');
    const repeatsId = cur !== null && id !== '' && id === cur.originalId && (title === '' || title === cur.title);
    if ((id || title || !cur) && !repeatsId) {
      const cell = cleanName(get(cells, 'module'));
      if (cell) columnModule = cell; // an empty module cell inherits the one above (merged or filled-down column)
      // The first source that has a value wins; "section" (heading rows) is the default for a table that has them.
      const sources: [NonNullable<TableReport['moduleFrom']>, string | null][] = [
        ['mapping', fixed], ['column', columnModule],
        ['title-prefix', source === 'title-prefix' ? titlePrefixOf(title) : null],
        ['sheet', source === 'sheet' ? sheetModule : null],
        ['section', sectionModule], ['sheet', sheetModule],
      ];
      const [from, module] = sources.find(([, name]) => name !== null) ?? [null, null];
      moduleFrom ??= from;
      cur = draft(line, null, id || null, title || id || `Row ${line}`);
      cur.module = module;
      cur.sheet = opts.sheet;
      cur.priority = get(cells, 'priority') || null;
      cur.tags = splitList(get(cells, 'tags'));
      cur.preconditions = cellLines(get(cells, 'preconditions')).map((l) => l.replace(NUMBERED, ''));
      for (const d of get(cells, 'data').split(/\r?\n|;/)) {
        const ref = d.trim() ? parseDataItem(d) : null;
        if (ref) cur.testData.push(ref);
      }
      drafts.push(cur);
    }
    addTableSteps(cur!, get(cells, 'steps'), get(cells, 'expected'));
  }
  // Prefixes shared by several cases ("Home page - ..."), offered as an alternative way to name the modules.
  const prefixCounts = new Map<string, number>();
  for (const d of drafts) {
    const p = titlePrefixOf(d.title);
    if (p) prefixCounts.set(p, (prefixCounts.get(p) ?? 0) + 1);
  }
  const shared = [...prefixCounts.values()].some((n) => n >= 2);
  const titlePrefixes = shared ? [...prefixCounts].slice(0, 30).map(([prefix, cases]) => ({ prefix, cases })) : [];
  return { drafts, moduleFrom, sections, titlePrefixes };
}

export function parseCsv(text: string, mapping?: TableMapping): DraftCase[] {
  const rows = parseCsvRecords(text);
  if (rows.length === 0) throw new Error('CSV is empty');
  const t = resolveTable(rows, mapping);
  if (t.status !== 'ok') throw new Error(`${t.reason}; found columns: ${t.header.filter((h) => h.trim()).map((h) => JSON.stringify(h.trim())).join(', ')}`);
  return parseTable(rows, t, { sheet: null, mapping }).drafts;
}

// One row may hold one step (multi-row cases) or a numbered list of steps (single-row cases).
function addTableSteps(c: DraftCase, stepsCell: string, expectedCell: string): void {
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

// Spreadsheet cases are keyed by sheet too, so the same title on two sheets stays two cases. Markdown/CSV IDs are unchanged.
function autoId(sourcePath: string, title: string, sheet: string | null = null): string {
  const where = sheet === null ? sourcePath : `${sourcePath}#${sheet}`;
  return `AUTO-${createHash('sha256').update(`${where}\n${title.trim().toLowerCase()}`).digest('hex').slice(0, 8)}`;
}

// The module a case belongs to: its explicit module (column, sheet, mapping), else its Markdown "# heading", else the file name.
function moduleOf(c: DraftCase, sourcePath: string): string {
  const stem = path.basename(sourcePath, path.extname(sourcePath));
  return cleanName(c.module ?? c.suite ?? '') || cleanName(stem) || 'General';
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
  // Credentials are moved to env vars before this runs, so what is left here could not be stored in a .env file.
  for (const d of c.testData) {
    if (isCredentialData(d)) {
      out.push({ kind: 'possible_secret_literal', message: `test data "${d.name}" looks like a credential but could not be moved to .env automatically (multi-line or unquotable value); put it in .env yourself and write env:VAR_NAME`, stepIndex: null });
    }
  }
  return out;
}

// Workbooks restart their numbering on every sheet ("TC001" on all of them) and often number with bare counters ("1").
// Such an ID is prefixed with its sheet (or file) name so it is unique and a valid test ID: "Target Block" + "TC001" -> TARGET-BLOCK-TC001.
function qualifyId(originalId: string, where: string): string | null {
  const slug = slugify(where).toUpperCase().slice(0, 30).replace(/-+$/, '');
  const prefix = /^[A-Z]/.test(slug) ? slug : `S${slug}`;
  const own = originalId.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const id = `${prefix}-${own}`;
  return own !== '' && TEST_ID_PATTERN.test(id) ? id : null;
}

export function normalizeCases(drafts: DraftCase[], sourcePath: string, seen: Map<string, TestSpec[]>): TestSpec[] {
  return drafts.map((c) => {
    const ambiguities = checkCase(c);
    let key = c.originalId ?? autoId(sourcePath, c.title, c.sheet);
    if (c.originalId !== null) {
      const where = c.sheet ?? path.basename(sourcePath, path.extname(sourcePath));
      // Only a workbook restarts its numbering per sheet; the same ID in two Markdown/CSV files is still a duplicate to flag.
      const usedElsewhere = c.sheet !== null && (seen.get(key) ?? []).some((p) => p.source.path !== sourcePath || p.source.sheet !== c.sheet);
      if (!TEST_ID_PATTERN.test(key) || usedElsewhere) key = qualifyId(key, where) ?? autoId(sourcePath, c.title, c.sheet);
    }
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
    const module = moduleOf(c, sourcePath);
    const spec: TestSpec = {
      id,
      title: c.title,
      source: { path: sourcePath, line: c.line, originalId: c.originalId, sheet: c.sheet },
      suite: c.suite,
      module,
      moduleSlug: slugify(module),
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
    .filter((d) => d.isFile() && !d.name.startsWith('.') && !d.name.startsWith('~$')) // dot files, and Excel's lock files for open workbooks
    .map((d) => path.join(d.parentPath, d.name))
    .sort();
}

export interface ParsedInputs {
  document: TestSpecDocument;
  errors: ParseError[];
  unsupported: string[];
  // One entry per CSV file / worksheet: how its columns were read, what was left out, and where each case's module came from.
  tables: TableReport[];
  // Credential/email literals found in the input, already replaced by env var names in `document`.
  // Contains values: the caller writes them to .env and must not print or store them elsewhere.
  credentials: DetectedCredential[];
}

interface RawTable { sheet: string | null; rows: TableRow[] }

function readTables(abs: string, format: 'csv' | 'xlsx'): RawTable[] {
  if (format === 'csv') return [{ sheet: null, rows: parseCsvRecords(readFileSync(abs, 'utf8')) }];
  return readXlsx(readFileSync(abs)).map((s) => ({ sheet: s.name, rows: s.rows }));
}

export function parseInputs(baseDir: string, files: string[], now: Date = new Date(), mappings?: InputMappings): ParsedInputs {
  const sources: SourceFile[] = [];
  const specs: TestSpec[] = [];
  const errors: ParseError[] = [];
  const unsupported: string[] = [];
  const tables: TableReport[] = [];
  const seen = new Map<string, TestSpec[]>();
  const parsed: { rel: string; drafts: DraftCase[] }[] = [];
  for (const abs of files) {
    const rel = toPosixRelative(baseDir, abs);
    const format = detectFormat(abs);
    if (!format) {
      const hint = CONVERT_FIRST[path.extname(abs).toLowerCase()];
      if (hint) errors.push({ path: rel, message: `cannot read this file: ${hint}` });
      else unsupported.push(rel);
      continue;
    }
    try {
      let drafts: DraftCase[];
      if (format === 'markdown') {
        drafts = parseMarkdown(readFileSync(abs, 'utf8'));
        if (drafts.length === 0) {
          errors.push({ path: rel, message: 'no test cases found (each case needs a "## <ID>: <title>" heading)' });
          continue;
        }
      } else {
        drafts = [];
        const fileErrors: ParseError[] = [];
        for (const raw of readTables(abs, format)) {
          const mapping = mappingFor(mappings, rel, raw.sheet);
          const t = resolveTable(raw.rows, mapping);
          const report: TableReport = { ...reportOf(rel, raw.sheet, t), moduleFrom: null, sections: [], titlePrefixes: [], cases: 0 };
          tables.push(report);
          const where = raw.sheet === null ? rel : `${rel} (sheet "${raw.sheet}")`;
          // A standalone CSV is the user's test-case file by definition; only a workbook sheet may be a cover page or notes.
          const notATable = raw.sheet === null && t.status === 'skipped' && !mapping?.skip && raw.rows.length > 0;
          if (t.status === 'unresolved' || notATable) {
            fileErrors.push({ path: rel, message: `${where}: ${t.reason}. Columns found: ${report.headers.map((h) => JSON.stringify(h)).join(', ') || 'none'}. Map them with "input map" (see "input inspect")` });
          }
          if (t.status !== 'ok') continue;
          const table = parseTable(raw.rows, t, { sheet: raw.sheet, mapping });
          report.cases = table.drafts.length;
          report.moduleFrom = table.moduleFrom ?? 'file';
          report.sections = table.sections;
          report.titlePrefixes = table.titlePrefixes;
          drafts.push(...table.drafts);
        }
        errors.push(...fileErrors);
        if (drafts.length === 0) {
          if (fileErrors.length === 0) {
            const mine = tables.filter((x) => x.path === rel);
            const why = mine.map((x) => `${x.sheet === null ? '' : `sheet "${x.sheet}": `}${x.reason ?? 'no data rows'}${x.headers.length ? ` (columns: ${x.headers.map((h) => JSON.stringify(h)).join(', ')})` : ''}`).join('; ');
            errors.push({ path: rel, message: mine.some((x) => x.status === 'ok') ? 'no data rows' : `no test-case table found: ${why || 'the file is empty'}` });
          }
          continue;
        }
      }
      sources.push({ path: rel, sha256: sha256File(abs), format });
      parsed.push({ rel, drafts });
    } catch (err) {
      errors.push({ path: rel, message: (err as Error).message });
    }
  }
  // After every file is read, so names the user wrote as env:VAR anywhere in the input are reserved first.
  const alloc = new EnvAllocator(parsed.flatMap((p) => p.drafts.flatMap((c) => c.testData.flatMap((d) => (d.envVar ? [d.envVar] : [])))));
  for (const { rel, drafts } of parsed) {
    for (const c of drafts) extractCredentials(c, c.originalId ?? autoId(rel, c.title, c.sheet), alloc);
    specs.push(...normalizeCases(drafts, rel, seen));
  }
  return {
    document: { schemaVersion: TEST_SPEC_SCHEMA_VERSION, generatedAt: now.toISOString(), sources, specs },
    errors,
    unsupported,
    tables,
    credentials: [...alloc.values].map(([envVar, value]) => ({ envVar, value })),
  };
}
