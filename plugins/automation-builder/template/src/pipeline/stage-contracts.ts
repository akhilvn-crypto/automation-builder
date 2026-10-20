// What each stage must produce before it may be marked `completed`.
// updateStage() enforces this, so a stage never advances on a missing or invalid artifact.

import path from 'node:path';
import { readJson } from '../utils/fs.ts';
import { validateExecutionResults } from './execution.ts';
import { validateExplorationRecord } from './exploration.ts';
import { validateFailureAnalysis } from './failure-classifier.ts';
import { validateGenerationManifest } from './generation.ts';
import { validateHealingLog } from './healing.ts';
import { validateInputValidationReport } from './input-validation.ts';
import { validateSummary } from './reporting.ts';
import type { RunManifest } from './run-manager.ts';
import type { StageName } from './state-manager.ts';
import { validateReviewReport } from './static-review.ts';
import { validateTestSpecDocument, type TestSpecDocument } from './test-spec.ts';

// Artifact names (manifest.artifacts keys) each stage must have registered to complete.
export const STAGE_REQUIRED_ARTIFACTS: Partial<Record<StageName, readonly string[]>> = {
  input_validation: ['inputValidation'],
  test_analysis: ['testSpecs'],
  application_exploration: ['exploration'],
  test_generation: ['generationManifest', 'generationReport'],
  script_review: ['reviewReport'],
  execution: ['executionResults'],
  failure_triage: ['failureAnalysis'],
  healing: ['healingLog'],
  regression_validation: ['regressionResults'],
  report_generation: ['summary', 'summaryMarkdown'],
};

interface Ctx {
  rootDir: string;
  runDir: string;
  manifest: RunManifest;
  artifacts: Record<string, string>; // merged: existing + being registered now
}

type Validator = (value: unknown, ctx: Ctx) => string[];

function loadSpecs(ctx: Ctx): TestSpecDocument | null {
  const rel = ctx.artifacts.testSpecs;
  if (!rel) return null;
  const r = readJson(path.join(ctx.runDir, rel));
  return r.ok ? (r.value as TestSpecDocument) : null;
}

const JSON_VALIDATORS: Record<string, Validator> = {
  inputValidation: (v) => validateInputValidationReport(v),
  testSpecs: (v) => {
    const issues = validateTestSpecDocument(v);
    const ready = (v as TestSpecDocument).specs?.filter((s) => s.status === 'ready').length ?? 0;
    if (issues.length === 0 && ready === 0) issues.push('no test case is ready: every case needs clarification');
    return issues;
  },
  exploration: (v, ctx) => validateExplorationRecord(v, { runDir: ctx.runDir, specs: loadSpecs(ctx) }),
  generationManifest: (v, ctx) => validateGenerationManifest(v, { rootDir: ctx.rootDir, specs: loadSpecs(ctx) }),
  reviewReport: (v) => validateReviewReport(v),
  executionResults: (v) => validateExecutionResults(v),
  failureAnalysis: (v) => validateFailureAnalysis(v),
  healingLog: (v, ctx) => validateHealingLog(v, ctx.manifest.healing.maxAttemptsPerTest),
  // Regression runs may contain genuine failures; only the runner itself must have worked.
  regressionResults: (v) => validateExecutionResults(v),
  summary: (v) => validateSummary(v),
};

export function checkStageOutputs(stage: StageName, ctx: Ctx): string[] {
  const issues: string[] = [];
  for (const name of STAGE_REQUIRED_ARTIFACTS[stage] ?? []) {
    const rel = ctx.artifacts[name];
    if (!rel) { issues.push(`required artifact "${name}" is not registered`); continue; }
    if (!rel.endsWith('.json')) continue; // existence/non-empty already checked by checkArtifactPath
    const r = readJson(path.join(ctx.runDir, rel));
    if (!r.ok) { issues.push(`artifact "${name}": ${r.message}`); continue; }
    const validate = JSON_VALIDATORS[name];
    if (validate) issues.push(...validate(r.value, ctx).map((m) => `${name}: ${m}`));
  }
  if (stage === 'finalization' && ctx.artifacts.summary && ctx.manifest.testCounts === null) {
    issues.push('test counts were not recorded (run "run finalize" first)');
  }
  return issues;
}

export class StageContractError extends Error {}
