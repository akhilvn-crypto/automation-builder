// Exploration record written by the application-explorer agent:
// dependencies/runs/<run-id>/exploration/exploration.json. Observations only — never requirements.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { isAbsoluteOrEscaping } from '../config/schema.ts';
import type { TestSpecDocument } from './test-spec.ts';

export const EXPLORATION_SCHEMA_VERSION = 1;
export const EXPLORATION_RECORD_TOOLS = ['playwright-cli', 'aria-snapshot-fallback'] as const;
export const CONFIDENCE = ['high', 'medium', 'low'] as const;
export const SPEC_EXPLORATION_STATUSES = ['explored', 'partial', 'blocked'] as const;

export interface ObservedElement {
  role: string | null;
  name: string | null;
  testId: string | null;
  // A durable Playwright locator expression, e.g. getByRole('button', { name: 'Sign in' }).
  candidateLocator: string;
  confidence: (typeof CONFIDENCE)[number];
  notes: string | null;
}

export interface PageProvenance {
  // fresh = observed by the explorer in this run; reused = carried over from the observation store and
  // revalidated against a snapshot taken in this run (`snapshot` below is that snapshot).
  source: 'fresh' | 'reused';
  fromRunId?: string;
  revalidatedAt?: string;
}

export interface ObservedPage {
  id: string;
  url: string;
  title: string | null;
  snapshot: string | null; // path relative to the run dir
  screenshot: string | null; // path relative to the run dir
  elements: ObservedElement[];
  provenance?: PageProvenance; // absent on records written without the reuse flow
}

// Written by `explore assemble`: which evidence was reused and why everything else was explored.
export interface ReuseSummary {
  reusedSpecs: string[];
  freshSpecs: string[];
  reusedPages: string[]; // page keys
  freshPages: string[];
  reasons: Record<string, string>; // testId -> why it was explored fresh / what it was reused from
}

export interface SpecExploration {
  testId: string;
  status: (typeof SPEC_EXPLORATION_STATUSES)[number];
  steps: { index: number; observed: string; pageId: string | null; locators: string[] }[];
  uncertainties: string[];
  notes: string | null;
}

export interface ExplorationRecord {
  schemaVersion: typeof EXPLORATION_SCHEMA_VERSION;
  tool: (typeof EXPLORATION_RECORD_TOOLS)[number];
  toolVersion: string | null;
  session: string | null;
  baseUrl: string;
  startedAt: string;
  endedAt: string;
  pages: ObservedPage[];
  specs: SpecExploration[];
  // Actions deliberately not performed because they looked destructive/irreversible.
  avoidedActions: string[];
  reuse?: ReuseSummary;
}

// Temporary CLI element references (e.g. "e12", "ref=e12", "aria-ref=e5") are exploration aids only.
export const CLI_REF_PATTERN = /(?:\baria-ref=|\bref=|^\s*|['"`])e\d+\b/;
const LOCATOR_START = /^(?:page\.)?(?:getBy(?:Role|Label|Text|Placeholder|AltText|Title|TestId)\(|locator\()/;

export function checkLocatorExpression(expr: string): string | null {
  if (typeof expr !== 'string' || expr.trim() === '') return 'locator is empty';
  if (CLI_REF_PATTERN.test(expr)) return `"${expr}" uses a temporary CLI element reference; use a semantic locator`;
  if (!LOCATOR_START.test(expr.trim())) return `"${expr}" is not a Playwright locator expression (getByRole/getByLabel/... or locator())`;
  return null;
}

export function validateExplorationRecord(v: unknown, ctx: { runDir: string; specs: TestSpecDocument | null }): string[] {
  if (typeof v !== 'object' || v === null) return ['exploration record must be an object'];
  const r = v as Partial<ExplorationRecord>;
  const issues: string[] = [];
  if (r.schemaVersion !== EXPLORATION_SCHEMA_VERSION) issues.push('unsupported schemaVersion');
  if (!(EXPLORATION_RECORD_TOOLS as readonly unknown[]).includes(r.tool)) issues.push(`tool must be one of ${EXPLORATION_RECORD_TOOLS.join(', ')}`);
  if (typeof r.baseUrl !== 'string') issues.push('baseUrl is required');
  if (!Array.isArray(r.pages)) issues.push('pages must be an array');
  if (!Array.isArray(r.specs)) issues.push('specs must be an array');
  if (!Array.isArray(r.avoidedActions)) issues.push('avoidedActions must be an array (may be empty)');
  if (issues.length) return issues;

  const pageIds = new Set<string>();
  for (const p of r.pages!) {
    pageIds.add(p.id);
    for (const [kind, rel] of [['snapshot', p.snapshot], ['screenshot', p.screenshot]] as const) {
      if (rel === null || rel === undefined) continue;
      if (isAbsoluteOrEscaping(rel)) issues.push(`page ${p.id} ${kind} path must be relative to the run dir`);
      else if (!existsSync(path.join(ctx.runDir, rel))) issues.push(`page ${p.id} ${kind} "${rel}" does not exist`);
    }
    if (p.provenance?.source === 'reused') {
      // Reused evidence is only acceptable with proof it was re-checked in this run.
      if (!p.provenance.revalidatedAt) issues.push(`page ${p.id} is reused but has no revalidatedAt`);
      if (!p.snapshot) issues.push(`page ${p.id} is reused but has no snapshot from this run`);
    }
    for (const e of p.elements ?? []) {
      const err = checkLocatorExpression(e.candidateLocator);
      if (err) issues.push(`page ${p.id}: ${err}`);
      if (!(CONFIDENCE as readonly unknown[]).includes(e.confidence)) issues.push(`page ${p.id}: element confidence must be high|medium|low`);
    }
  }
  for (const s of r.specs!) {
    if (!(SPEC_EXPLORATION_STATUSES as readonly unknown[]).includes(s.status)) issues.push(`${s.testId}: invalid status ${JSON.stringify(s.status)}`);
    for (const st of s.steps ?? []) {
      if (st.pageId !== null && !pageIds.has(st.pageId)) issues.push(`${s.testId} step ${st.index}: unknown pageId "${st.pageId}"`);
      for (const loc of st.locators ?? []) {
        const err = checkLocatorExpression(loc);
        if (err) issues.push(`${s.testId} step ${st.index}: ${err}`);
      }
    }
    if (s.status !== 'explored' && (s.uncertainties ?? []).length === 0) {
      issues.push(`${s.testId} is ${s.status} but lists no uncertainties explaining why`);
    }
  }
  if (ctx.specs) {
    const covered = new Set(r.specs!.map((s) => s.testId));
    for (const s of ctx.specs.specs) {
      if (s.status === 'ready' && !covered.has(s.id)) issues.push(`ready spec ${s.id} has no exploration entry`);
    }
  }
  return issues;
}
