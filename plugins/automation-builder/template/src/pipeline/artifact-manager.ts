// Run directory layout and artifact path rules.
// Artifact paths stored in the manifest are always relative to the run directory.

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { isAbsoluteOrEscaping } from '../config/schema.ts';

export const RUNS_RELATIVE_DIR = 'output/runs';

// Well-known artifact names. Only registered once the file actually exists.
export const ARTIFACTS = {
  manifest: 'manifest.json',
  inputValidation: 'input-validation.json',
  inputCopyDir: 'input', // verbatim copy of the original test-case files
  testSpecs: 'test-specs.json',
  explorationDir: 'exploration',
  exploration: 'exploration/exploration.json',
  generationManifest: 'generation-manifest.json',
  generationReport: 'generation-report.md',
  reviewReport: 'review-report.json',
  reviewSummary: 'review-report.md',
  executionResults: 'execution-results.json',
  failureAnalysis: 'failure-analysis.json',
  healingDir: 'healing', // per-attempt before-snapshots
  healingLog: 'healing-log.json',
  regressionResults: 'regression-results.json',
  rerunsDir: 'reruns', // normalized results of targeted reruns, one file per label
  reportsDir: 'reports', // raw reporter output per execution label, plus the final summary
  summary: 'reports/summary.json',
  summaryMarkdown: 'reports/summary.md',
  evidenceDir: 'evidence', // Playwright outputDir per execution label
} as const;

// Execution labels name one Playwright invocation inside a run: "initial", "heal-TC-001-1", "regression".
export const EXECUTION_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;

export function assertExecutionLabel(label: string): void {
  if (!EXECUTION_LABEL_PATTERN.test(label)) throw new Error(`invalid execution label "${label}"`);
}

export function reportsDirFor(runDirectory: string, label: string): string {
  assertExecutionLabel(label);
  return path.join(runDirectory, ARTIFACTS.reportsDir, label);
}

export function evidenceDirFor(runDirectory: string, label: string): string {
  assertExecutionLabel(label);
  return path.join(runDirectory, ARTIFACTS.evidenceDir, label);
}

export function runsDir(rootDir: string): string {
  return path.join(rootDir, RUNS_RELATIVE_DIR);
}

export function runDir(rootDir: string, runId: string): string {
  assertRunId(runId);
  return path.join(runsDir(rootDir), runId);
}

export const RUN_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

export function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`invalid run id "${runId}" (expected YYYYMMDD-HHMMSS-xxxxxx)`);
}

export function checkArtifactPath(runDirectory: string, rel: string): string | null {
  if (typeof rel !== 'string' || rel.trim() === '') return 'artifact path must be a non-empty string';
  if (isAbsoluteOrEscaping(rel)) return `artifact path "${rel}" must be relative to the run directory`;
  const abs = path.join(runDirectory, rel);
  if (!existsSync(abs)) return `artifact "${rel}" does not exist`;
  const st = statSync(abs);
  if (st.isFile() && st.size === 0) return `artifact "${rel}" is empty`;
  return null;
}
