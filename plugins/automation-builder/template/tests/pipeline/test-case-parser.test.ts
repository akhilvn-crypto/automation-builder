import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  listInputFiles, mapColumns, parseCsv, parseCsvRecords, parseInputs, parseMarkdown,
} from '../../engine/pipeline/test-case-parser.ts';
import { validateTestSpecDocument } from '../../engine/pipeline/test-spec.ts';
import { tmpRoot, writeFile } from './helpers.ts';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('bundled examples parse into valid, ready specs with source traceability', () => {
  const files = listInputFiles(PROJECT, 'docs/examples');
  const { document, errors, unsupported } = parseInputs(PROJECT, files, new Date('2026-10-20T00:00:00Z'));
  assert.deepEqual(errors, []);
  assert.deepEqual(unsupported, []);
  assert.deepEqual(validateTestSpecDocument(document), []);
  const byId = Object.fromEntries(document.specs.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ['TC-001', 'TC-002', 'TC-101', 'TC-102']);
  for (const s of document.specs) assert.equal(s.status, 'ready', `${s.id}: ${JSON.stringify(s.ambiguities)}`);

  const login = byId['TC-001']!;
  assert.equal(login.source.path, 'docs/examples/login.example.md');
  assert.equal(login.source.line, 3);
  assert.equal(login.suite, 'Login');
  assert.deepEqual(login.tags, ['smoke', 'auth']);
  assert.equal(login.steps.length, 4);
  assert.equal(login.steps[3]!.expected, 'The dashboard is displayed');
  assert.deepEqual(login.expectedResults, ['The heading "Dashboard" is visible', 'The URL contains "/dashboard"']);
  assert.deepEqual(login.testData[1], { name: 'password', value: null, envVar: 'TEST_USER_PASSWORD', declaredLiteral: false });

  const wrong = byId['TC-002']!;
  assert.equal(wrong.steps[3]!.action, 'Click the "Sign in" button');
  assert.equal(wrong.steps[3]!.expected, 'The error "Invalid email or password" is shown');
  assert.equal(wrong.testData[1]!.declaredLiteral, true);

  const cart = byId['TC-101']!;
  assert.deepEqual(cart.steps.map((s) => s.expected), ['The cart badge shows 1', 'The cart lists the product']);
  const remove = byId['TC-102']!;
  assert.equal(remove.steps.length, 2, 'continuation row adds a step');
  assert.equal(remove.steps[1]!.expected, 'The cart is empty and shows "Your cart is empty"');
});

test('markdown labels ("Steps:", "Expected Result:") work as well as headings', () => {
  const [c] = parseMarkdown('## TC-5: Labels\nSteps:\n1. Open home\nExpected Result: Home is shown\n');
  assert.deepEqual(c!.steps, [{ action: 'Open home', expected: null }]);
  assert.deepEqual(c!.expectedResults, ['Home is shown']);
});

test('missing expected results, undefined data and secret literals are flagged, not invented', (t) => {
  const root = tmpRoot(t);
  const f = writeFile(root, 'in/a.md', [
    '## TC-9: Something', '### Test Data', '- password: hunter2', '### Steps', '1. Type {password}', '2. Type {username}',
    '## TC-10: Vague', '### Steps', '1. Click save', '### Expected Results', '- It works correctly',
    '## No id here', '### Steps', '1. Do it', '### Expected Results', '- Done is shown',
  ].join('\n'));
  const { document } = parseInputs(root, [f]);
  assert.deepEqual(validateTestSpecDocument(document), []);
  const [a, b, c] = document.specs;
  const kinds = a!.ambiguities.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['missing_expected_result', 'possible_secret_literal', 'undefined_data_reference']);
  assert.equal(a!.status, 'needs_clarification');
  assert.deepEqual(b!.ambiguities.map((x) => x.kind), ['vague_expected_result']);
  assert.equal(b!.status, 'ready', 'vague is a warning, not a blocker');
  assert.match(c!.id, /^AUTO-[0-9a-f]{8}$/);
  const again = parseInputs(root, [f]).document.specs[2]!;
  assert.equal(again.id, c!.id, 'generated IDs are stable across parses');
});

test('duplicate IDs are flagged on every occurrence and kept unique', (t) => {
  const root = tmpRoot(t);
  const a = writeFile(root, 'in/a.md', '## TC-1: A\n### Steps\n1. x -> Expected: y\n');
  const b = writeFile(root, 'in/b.md', '## TC-1: B\n### Steps\n1. x -> Expected: y\n');
  const { document } = parseInputs(root, [a, b]);
  assert.deepEqual(document.specs.map((s) => s.id), ['TC-1', 'TC-1-dup2']);
  assert.ok(document.specs.every((s) => s.status === 'needs_clarification'));
  assert.deepEqual(validateTestSpecDocument(document), []);
});

test('CSV parser handles quotes, embedded newlines, CRLF and semicolon delimiters', () => {
  const recs = parseCsvRecords('a,b\r\n"x, ""y""","line1\nline2"\r\n');
  assert.deepEqual(recs, [{ line: 1, cells: ['a', 'b'] }, { line: 2, cells: ['x, "y"', 'line1\nline2'] }]);
  assert.deepEqual(parseCsvRecords('a;b\n1;2\n')[1]!.cells, ['1', '2']);
  assert.throws(() => parseCsvRecords('a\n"open'), /unterminated/);
});

test('CSV without required columns fails with the columns it found', () => {
  assert.deepEqual(mapColumns(['ID', 'Title', 'Steps', 'Expected Result']).errors, []);
  assert.throws(() => parseCsv('Name,Notes\nx,y\n'), /needs a steps column.*found columns: "Name", "Notes"/s);
});

test('unsupported files and empty inputs are reported', (t) => {
  const root = tmpRoot(t);
  const x = writeFile(root, 'in/suite.xlsx', 'binary');
  const e = writeFile(root, 'in/empty.md', '# Only a title\n');
  const { document, errors, unsupported } = parseInputs(root, [x, e]);
  assert.deepEqual(unsupported, ['in/suite.xlsx']);
  assert.match(errors[0]!.message, /no test cases found/);
  assert.ok(validateTestSpecDocument(document).some((i) => /no test cases/.test(i)));
});

test('validator rejects a needs_clarification case hand-marked as ready', (t) => {
  const root = tmpRoot(t);
  const f = writeFile(root, 'in/a.md', '## TC-1: A\n### Steps\n1. Click\n');
  const { document } = parseInputs(root, [f]);
  document.specs[0]!.status = 'ready';
  assert.ok(validateTestSpecDocument(document).some((i) => /status must be "needs_clarification"/.test(i)));
});
