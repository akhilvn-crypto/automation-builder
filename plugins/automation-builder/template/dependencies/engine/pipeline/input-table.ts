// Table-shaped test-case input (CSV and every .xlsx sheet): finding the header row, mapping the user's own column names
// onto the test-spec fields, and the saved per-file overrides for layouts the built-in aliases do not recognise.
// Nothing here reads cell values into specs; test-case-parser.ts does that with the mapping resolved here.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stateDir } from '../utils/layout.ts';

export const FIELDS = ['id', 'title', 'module', 'preconditions', 'steps', 'expected', 'data', 'priority', 'tags'] as const;
export type Field = (typeof FIELDS)[number];

export interface TableRow { line: number; cells: string[] }

// A header cell, lower-cased with every run of punctuation/whitespace collapsed to one space: "Pre-Conditions" -> "pre conditions".
export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const ALIASES: Record<Field, readonly string[]> = {
  id: ['id', 'tc', 'tcid', 'test id', 'case id', 'case no', 'case number', 'test no', 'test number', 'ticket id', 'ref', 'ref id', 'ref no', 'reference', 'reference id', 'reference no'],
  title: [
    'title', 'name', 'summary', 'scenario', 'scenarios', 'test scenarios', 'test', 'testcase', 'test case', 'test title', 'test name', 'test summary', 'test scenario',
    'test case title', 'test case name', 'test case summary', 'test case description', 'testcase description', 'test description',
    'scenario name', 'scenario title', 'scenario description', 'objective', 'test objective', 'use case',
  ],
  module: ['module', 'module name', 'feature', 'feature name', 'functionality', 'functional area', 'area', 'component', 'application area', 'module feature'],
  preconditions: ['preconditions', 'precondition', 'pre conditions', 'pre condition', 'prerequisites', 'prerequisite', 'pre requisites', 'pre requisite', 'pre req', 'prereq', 'setup'],
  steps: [
    'steps', 'step', 'test steps', 'test step', 'action', 'actions', 'test actions', 'step description', 'steps description', 'test step description',
    'test steps description', 'step details', 'procedure', 'test procedure', 'steps to execute', 'steps to reproduce', 'execution steps', 'scenario steps',
  ],
  expected: ['expected', 'expected result', 'expected results', 'expected outcome', 'expected output', 'expected behaviour', 'expected behavior', 'result expected'],
  data: ['test data', 'data', 'input data', 'test input', 'test inputs', 'input', 'inputs'],
  priority: ['priority', 'prio', 'test priority'],
  tags: ['tags', 'tag', 'labels', 'label', 'keywords'],
};
// "TC ID", "Test Case No.", "Scenario #", ... : any test/case/scenario word followed by id/no/number/ref.
const ID_PATTERN = /^(?:test ?case|testcase|tc|test|case|scenario|test scenario)(?: ?(?:id|no|number|ref|#))$/;
// "Expected", "Expected Result", "Expected Result (as per spec)": a short, letters-only header, not a sentence or a note with numbers in it.
const EXPECTED_PATTERN = /^expected(?: (?!actual\b)[a-z]+){0,5}$/;

const SERIAL_NUMBER = /^(?:s no|sno|sl no|sr no|serial no|serial number)$/;

function fieldOf(header: string): Field | null {
  if (header === '') return null;
  if (ID_PATTERN.test(header)) return 'id';
  if (EXPECTED_PATTERN.test(header)) return 'expected';
  for (const f of FIELDS) if (ALIASES[f].includes(header)) return f;
  return null;
}

export function autoMapColumns(header: string[]): Partial<Record<Field, number>> {
  const columns: Partial<Record<Field, number>> = {};
  header.forEach((h, i) => {
    const f = fieldOf(normalizeHeader(h));
    if (f && columns[f] === undefined) columns[f] = i;
  });
  // A bare "Description" column is the title only when nothing better names it.
  const description = header.findIndex((h) => normalizeHeader(h) === 'description');
  if (description >= 0 && columns.title === undefined) columns.title = description;
  // A serial-number column ("S. No.") is the ID only when the sheet has no real ID column.
  const serial = header.findIndex((h) => SERIAL_NUMBER.test(normalizeHeader(h)));
  if (serial >= 0 && columns.id === undefined) columns.id = serial;
  return columns;
}

export const MODULE_SOURCES = ['section', 'sheet', 'title-prefix'] as const;

// Saved override for one table, written by `input map`. `columns` maps a field to the header text the user's file uses.
export interface TableMapping {
  headerRow?: number; // 1-based sheet/CSV row holding the headers
  columns?: Partial<Record<Field, string>>;
  module?: string; // one module name for every case in this table
  // Where each case's module comes from when there is no module column: the section heading rows above the cases (the
  // default when the table has them), the sheet name, or the text before " - " in the case title ("Home page - banners").
  moduleSource?: (typeof MODULE_SOURCES)[number];
  skip?: boolean; // not a test-case table (cover page, notes, lookup list)
}
export interface InputMappings { schemaVersion: 1; tables: Record<string, TableMapping> }

export function mappingKey(relPath: string, sheet: string | null): string {
  return sheet === null ? relPath : `${relPath}#${sheet}`;
}

export function mappingFile(rootDir: string): string {
  return path.join(stateDir(rootDir), 'input-mapping.json');
}

export function emptyMappings(): InputMappings { return { schemaVersion: 1, tables: {} }; }

export function loadMappings(rootDir: string): InputMappings {
  const file = mappingFile(rootDir);
  if (!existsSync(file)) return emptyMappings();
  try {
    const v = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as Partial<InputMappings>;
    if (v.schemaVersion === 1 && v.tables && typeof v.tables === 'object') return v as InputMappings;
  } catch { /* fall through */ }
  throw new Error(`${file} is not a valid input mapping file; fix or delete it`);
}

export function saveMappings(rootDir: string, m: InputMappings): void {
  const file = mappingFile(rootDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
  renameSync(tmp, file);
}

// A workbook-wide entry ("input/x.xlsx") applies to every sheet that has no entry of its own.
export function mappingFor(m: InputMappings | undefined, relPath: string, sheet: string | null): TableMapping | undefined {
  return m?.tables[mappingKey(relPath, sheet)] ?? (sheet === null ? undefined : m?.tables[relPath]);
}

export interface ResolvedTable {
  status: 'ok' | 'skipped' | 'unresolved';
  headerLine: number | null;
  headerIndex: number; // index into rows, -1 when none
  header: string[];
  columns: Partial<Record<Field, number>>;
  ignored: string[];
  reason: string | null; // why skipped/unresolved
}

const HEADER_SCAN_ROWS = 25;

function headerIndexFor(rows: TableRow[], headerRow: number | undefined): number {
  if (headerRow === undefined) return -1;
  return rows.findIndex((r) => r.line === headerRow);
}

// The columns of one row read as a header: built-in names, then the saved overrides wherever the row has the header text they name.
function columnsFor(cells: string[], override: TableMapping | undefined): Partial<Record<Field, number>> {
  const columns = autoMapColumns(cells);
  const norm = cells.map(normalizeHeader);
  for (const [field, text] of Object.entries(override?.columns ?? {}) as [Field, string][]) {
    const at = norm.indexOf(normalizeHeader(text));
    if (at >= 0) columns[field] = at;
  }
  return columns;
}

// Resolves the header row and columns of one table. Unless a header row is saved, the first of the first rows that names a
// steps column and an expected-result column is the header (spreadsheets often carry a title block above it).
export function resolveTable(rows: TableRow[], override: TableMapping | undefined): ResolvedTable {
  const fail = (status: ResolvedTable['status'], reason: string, header: string[] = [], headerLine: number | null = null): ResolvedTable =>
    ({ status, headerLine, headerIndex: -1, header, columns: {}, ignored: [], reason });
  if (override?.skip) return fail('skipped', 'skipped by the saved input mapping');
  if (rows.length === 0) return fail('skipped', 'no rows');

  let idx = headerIndexFor(rows, override?.headerRow);
  if (override?.headerRow !== undefined && idx < 0) return fail('unresolved', `header row ${override.headerRow} holds no values`);
  const scanned = rows.slice(0, HEADER_SCAN_ROWS);
  if (idx < 0) {
    idx = scanned.findIndex((r) => {
      const c = columnsFor(r.cells, override);
      return c.steps !== undefined && c.expected !== undefined;
    });
  }
  if (idx < 0) {
    // Report the row that looked most like a header, so the user sees which columns were found.
    const best = scanned.reduce((a, r) => (Object.keys(columnsFor(r.cells, override)).length > Object.keys(columnsFor(a.cells, override)).length ? r : a), rows[0]!);
    const found = columnsFor(best.cells, override);
    const wanted = Object.entries(override?.columns ?? {});
    const testLike = found.steps !== undefined || found.expected !== undefined || wanted.length > 0;
    const missing = [found.steps === undefined ? 'steps' : '', found.expected === undefined ? 'expected result' : ''].filter(Boolean).join(' and ');
    const reason = wanted.length > 0
      ? `no row in the first ${HEADER_SCAN_ROWS} has the saved column(s) ${wanted.map(([f, t]) => `${f}="${t}"`).join(', ')} together with ${missing || 'the rest of the headers'}`
      : testLike ? `no ${missing} column recognised` : 'no steps or expected-result column recognised';
    return fail(testLike ? 'unresolved' : 'skipped', reason, best.cells, best.line);
  }

  const row = rows[idx]!;
  const norm = row.cells.map(normalizeHeader);
  for (const [field, text] of Object.entries(override?.columns ?? {}) as [Field, string][]) {
    if (!norm.includes(normalizeHeader(text))) {
      return fail('unresolved', `mapped column "${text}" (${field}) is not in the header row (found: ${row.cells.filter((c) => c.trim()).map((c) => JSON.stringify(c.trim())).join(', ')})`, row.cells, row.line);
    }
  }
  const columns = columnsFor(row.cells, override);
  // Whatever no field claims is reported, so a dropped column is visible rather than silent.
  const used = new Set(Object.values(columns));
  const stillIgnored = row.cells.filter((c, i) => c.trim() !== '' && !used.has(i)).map((c) => c.trim());

  if (columns.steps === undefined || columns.expected === undefined || (columns.title === undefined && columns.id === undefined)) {
    const missing = [
      columns.title === undefined && columns.id === undefined ? 'test case ID or title' : '',
      columns.steps === undefined ? 'steps' : '',
      columns.expected === undefined ? 'expected result' : '',
    ].filter(Boolean).join(', ');
    return { status: 'unresolved', headerLine: row.line, headerIndex: idx, header: row.cells, columns, ignored: stillIgnored, reason: `missing column(s): ${missing}` };
  }
  return { status: 'ok', headerLine: row.line, headerIndex: idx, header: row.cells, columns, ignored: stillIgnored, reason: null };
}

export interface TableReport {
  path: string; // relative to dependencies/
  sheet: string | null;
  status: ResolvedTable['status'];
  reason: string | null;
  headerLine: number | null;
  mapped: Partial<Record<Field, string>>; // field -> the header text it was read from
  ignoredColumns: string[];
  headers: string[]; // every non-empty header cell of the header row, so a mapping can be written for an unresolved table
  moduleFrom: 'column' | 'section' | 'title-prefix' | 'sheet' | 'file' | 'mapping' | null;
  // Heading rows found between cases (a row with only its first cell filled), and the "<prefix> - " parts of case titles with how
  // many cases use each. Offered so the user can choose which one names the modules; empty when there are none.
  sections: string[];
  titlePrefixes: { prefix: string; cases: number }[];
  cases: number;
}

export function reportOf(rel: string, sheet: string | null, t: ResolvedTable): Omit<TableReport, 'moduleFrom' | 'sections' | 'titlePrefixes' | 'cases'> {
  const mapped: Partial<Record<Field, string>> = {};
  for (const [f, i] of Object.entries(t.columns) as [Field, number][]) mapped[f] = t.header[i]?.trim() ?? '';
  return {
    path: rel, sheet, status: t.status, reason: t.reason, headerLine: t.headerLine, mapped,
    ignoredColumns: t.ignored, headers: t.header.map((h) => h.trim()).filter(Boolean),
  };
}
