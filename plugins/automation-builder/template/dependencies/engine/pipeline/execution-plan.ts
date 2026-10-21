// How many Playwright workers run, and how much runs in parallel inside a file, decided from what the project has
// declared about shared state. Pure: the same inputs give the same plan, so playwright.config.ts (inside Playwright) and
// the CLI (which records the plan with the results) always agree.
//
// Principles: start conservative and let measurement justify more; never run more workers than there are independent
// accounts when tests may change shared data; make every limit visible with its reason.

import os from 'node:os';
import type { AutomationConfig, IsolationMode } from '../config/schema.ts';

// Used when execution.workers is not set. Deliberately not Playwright's CPU-based default: more workers are only worth
// it after run-to-run measurements (see `run compare`) show no loss of correctness.
export const CONSERVATIVE_DEFAULT_WORKERS = 2;

export interface AccountPool {
  envVar: string; // credential variable the pool belongs to (NAME)
  size: number; // how many NAME_1..NAME_N are defined
}

export interface ExecutionPlan {
  workers: number;
  fullyParallel: boolean; // tests inside one file may also run in parallel
  isolation: IsolationMode | 'unspecified';
  requestedWorkers: number | null;
  workersSource: 'config' | 'default';
  limits: string[]; // why the worker count is lower than requested
  warnings: string[];
  accountPool: AccountPool[] | null; // only for per-worker-accounts
}

// NAME_1, NAME_2, ... counted while consecutive. Names only; values are never read here.
export function accountPool(envVars: readonly string[], env: NodeJS.ProcessEnv): AccountPool[] {
  return envVars.map((envVar) => {
    let size = 0;
    while (env[`${envVar}_${size + 1}`] !== undefined && env[`${envVar}_${size + 1}`] !== '') size++;
    return { envVar, size };
  });
}

export function resolveExecutionPlan(config: AutomationConfig, env: NodeJS.ProcessEnv, cpus: number = os.availableParallelism()): ExecutionPlan {
  const requested = config.execution.workers;
  const isolation = config.execution.isolation ?? 'unspecified';
  const limits: string[] = [];
  const warnings: string[] = [];
  let workers = requested ?? Math.min(CONSERVATIVE_DEFAULT_WORKERS, Math.max(1, cpus));
  if (requested !== null && requested > cpus) warnings.push(`${requested} workers requested on a machine with ${cpus} CPUs: measure before keeping this`);

  let pool: AccountPool[] | null = null;
  if (isolation === 'serial') {
    if (workers > 1) limits.push('isolation "serial": tests run one after another');
    workers = 1;
  } else if (isolation === 'per-worker-accounts') {
    pool = accountPool(config.auth.credentialEnvVars, env);
    const size = pool.length === 0 ? 0 : Math.min(...pool.map((p) => p.size));
    const incomplete = pool.filter((p) => p.size === 0).map((p) => p.envVar);
    if (size === 0) {
      limits.push(`isolation "per-worker-accounts" but no per-worker credentials were found (${incomplete.map((n) => `${n}_1`).join(', ')}): running one worker`);
      workers = 1;
    } else if (workers > size) {
      limits.push(`only ${size} account(s) defined for every credential: limited to ${size} worker(s)`);
      workers = size;
    }
  } else if (isolation === 'unspecified' && requested !== null && requested > 1 && config.auth.approach !== 'none') {
    warnings.push('several workers share one account; set execution.isolation ("shared-readonly" if tests never change shared data, "serial" if they do) to confirm this is safe');
  }

  return {
    workers, fullyParallel: isolation === 'shared-readonly' || isolation === 'per-worker-accounts', isolation,
    requestedWorkers: requested, workersSource: requested === null ? 'default' : 'config', limits, warnings, accountPool: pool,
  };
}
