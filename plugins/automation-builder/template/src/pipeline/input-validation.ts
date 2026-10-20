// input_validation stage: confirm the test-case input exists, is a supported format and parses,
// then keep a verbatim copy inside the run so the original input is preserved with the evidence.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { isAbsoluteOrEscaping } from '../config/schema.ts';
import { sha256File, toPosixRelative, writeJsonAtomic } from '../utils/fs.ts';
import { ARTIFACTS } from './artifact-manager.ts';
import { detectFormat, listInputFiles, parseInputs, type ParseError } from './test-case-parser.ts';
import type { InputFormat } from './test-spec.ts';

export const INPUT_VALIDATION_SCHEMA_VERSION = 1;

export interface InputValidationReport {
  schemaVersion: typeof INPUT_VALIDATION_SCHEMA_VERSION;
  validatedAt: string;
  inputPath: string;
  files: { path: string; format: InputFormat | null; sha256: string; copiedTo: string | null }[];
  unsupported: string[];
  errors: ParseError[];
  caseCount: number;
  ok: boolean;
}

export function validateInput(rootDir: string, runDirectory: string, inputPath: string, now = new Date()): InputValidationReport {
  const base: Omit<InputValidationReport, 'ok'> = {
    schemaVersion: INPUT_VALIDATION_SCHEMA_VERSION,
    validatedAt: now.toISOString(),
    inputPath,
    files: [],
    unsupported: [],
    errors: [],
    caseCount: 0,
  };
  if (isAbsoluteOrEscaping(inputPath)) {
    return finish(runDirectory, { ...base, errors: [{ path: inputPath, message: 'input path must be relative and inside the project' }] });
  }
  if (!existsSync(path.resolve(rootDir, inputPath))) {
    return finish(runDirectory, { ...base, errors: [{ path: inputPath, message: 'input path does not exist' }] });
  }
  const files = listInputFiles(rootDir, inputPath);
  const parsed = parseInputs(rootDir, files, now);
  const copyRoot = path.join(runDirectory, ARTIFACTS.inputCopyDir);
  const entries = files.map((abs) => {
    const rel = toPosixRelative(rootDir, abs);
    const format = detectFormat(abs);
    let copiedTo: string | null = null;
    if (format) {
      const dest = path.join(copyRoot, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(abs, dest);
      copiedTo = toPosixRelative(runDirectory, dest);
    }
    return { path: rel, format, sha256: sha256File(abs), copiedTo };
  });
  const errors = [...parsed.errors];
  if (entries.every((e) => e.format === null)) {
    errors.push({ path: inputPath, message: `no supported test-case files (supported: .md, .csv; found ${entries.length} file(s))` });
  }
  return finish(runDirectory, { ...base, files: entries, unsupported: parsed.unsupported, errors, caseCount: parsed.document.specs.length });
}

function finish(runDirectory: string, r: Omit<InputValidationReport, 'ok'>): InputValidationReport {
  const report: InputValidationReport = { ...r, ok: r.errors.length === 0 && r.caseCount > 0 };
  writeJsonAtomic(path.join(runDirectory, ARTIFACTS.inputValidation), report);
  return report;
}

export function validateInputValidationReport(v: unknown): string[] {
  const r = v as Partial<InputValidationReport>;
  if (typeof r !== 'object' || r === null) return ['input-validation must be an object'];
  const issues: string[] = [];
  if (r.schemaVersion !== INPUT_VALIDATION_SCHEMA_VERSION) issues.push('unsupported schemaVersion');
  if (r.ok !== true) issues.push(`input validation did not pass: ${(r.errors ?? []).map((e) => `${e.path}: ${e.message}`).join('; ') || 'no test cases'}`);
  return issues;
}
