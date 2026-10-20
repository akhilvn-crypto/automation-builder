// Test-data helpers shared by generated and handwritten tests. No Playwright import.

import { randomBytes } from 'node:crypto';

export class MissingEnvError extends Error {}

/**
 * Read a required value (usually a credential) from the environment. Never log the value.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function requireEnv(name, env = process.env) {
  const v = env[name];
  if (v === undefined || v === '') {
    throw new MissingEnvError(`Missing required environment variable ${name}. Set it in .env (see .env.example); never hard-code it.`);
  }
  return v;
}

/**
 * Unique suffix for records a test creates, so parallel tests and reruns don't collide.
 * @param {string} [prefix]
 * @returns {string}
 */
export function uniqueSuffix(prefix = 't') {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

/**
 * Replace every occurrence of the given secret values (min length 3) with "***".
 * @param {string} text
 * @param {readonly string[]} secrets
 * @returns {string}
 */
export function redact(text, secrets) {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.split(s).join('***');
  }
  return out;
}

/**
 * @param {readonly string[]} envVarNames
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function secretValues(envVarNames, env = process.env) {
  return envVarNames.map((n) => env[n]).filter((v) => typeof v === 'string' && v.length > 0);
}
