// dependencies/state/scaffold.json is written once by /automation-builder:init. It records the language the user chose
// while scaffolding the framework (the files on disk are language-specific), so setup never asks again
// and config can never drift from the scaffolded files.

import path from 'node:path';
import { readJson } from '../utils/fs.ts';
import { stateDir } from '../utils/layout.ts';
import { LANGUAGES, type Language } from './schema.ts';

export const SCAFFOLD_FILE = 'scaffold.json'; // inside dependencies/state/

export interface Scaffold {
  pluginVersion: string;
  language: Language;
}

export function readScaffold(rootDir: string): Scaffold | null {
  const r = readJson(path.join(stateDir(rootDir), SCAFFOLD_FILE));
  if (!r.ok || typeof r.value !== 'object' || r.value === null) return null;
  const v = r.value as Partial<Scaffold>;
  if (!(LANGUAGES as readonly unknown[]).includes(v.language)) return null;
  return { pluginVersion: typeof v.pluginVersion === 'string' ? v.pluginVersion : 'unknown', language: v.language as Language };
}
