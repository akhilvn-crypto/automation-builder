import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Write JSON via a temp file in the same directory, then rename over the target,
// so readers never observe a half-written file.
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, filePath);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export type JsonReadResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'not_found' | 'parse_error'; message: string };

export function readJson(filePath: string): JsonReadResult {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: 'not_found', message: `${filePath} does not exist` };
    }
    throw err;
  }
  try {
    return { ok: true, value: JSON.parse(text.replace(/^﻿/, '')) };
  } catch (err) {
    return { ok: false, reason: 'parse_error', message: `${filePath} is not valid JSON: ${(err as Error).message}` };
  }
}

export function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

// Forward-slash relative path, for stable values in JSON artifacts across OSes.
export function toPosixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}
