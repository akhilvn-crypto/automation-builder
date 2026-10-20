// Test-data helpers shared by generated tests. No Playwright import, so the pipeline can test them.

import { randomBytes } from 'node:crypto';

export class MissingEnvError extends Error {}

// Read a required value (usually a credential) from the environment. Never log the value.
export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name];
  if (v === undefined || v === '') {
    throw new MissingEnvError(`Missing required environment variable ${name}. Set it in .env (see .env.example); never hard-code it.`);
  }
  return v;
}

// Unique suffix for records a test creates, so parallel tests and reruns don't collide.
export function uniqueSuffix(prefix = 't'): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

// Replace every occurrence of the given secret values (min length 3) with "***".
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.split(s).join('***');
  }
  return out;
}

export function secretValues(envVarNames: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  return envVarNames.map((n) => env[n]).filter((v): v is string => typeof v === 'string' && v.length > 0);
}
