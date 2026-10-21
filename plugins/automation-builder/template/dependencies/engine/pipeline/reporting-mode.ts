// Report modes: how much reporting a run produces. The mode is a persisted setup choice (reporting.mode); it only ever
// constrains or suggests what the user selected, so reporters are never generated or installed behind their back.
//
//   standard  JSON + Playwright HTML; failure-focused screenshots/traces       default development runs
//   full      standard + Allure + video retained for failures                  team testing and CI
//   audit     full + opt-in step evidence and the optional evidence PDF        formal sign-off
//
// Validation of a configuration against its mode lives in config/schema.ts; this file turns a mode into a plan the setup
// flow and `report build` can show, and into a preset the user can approve and save.

import type { AutomationConfig, Reporter, ReportMode } from '../config/schema.ts';

export interface ModeProfile {
  mode: ReportMode;
  intendedFor: string;
  reporters: readonly Reporter[]; // what the mode produces by default
  evidence: AutomationConfig['evidence']; // suggested Playwright evidence settings
  needs: readonly string[]; // optional software the mode relies on (each needs its own approval to install)
  volume: string; // what to expect on disk
}

export const MODE_PROFILES: Record<ReportMode, ModeProfile> = {
  standard: {
    mode: 'standard', intendedFor: 'default development runs', reporters: ['json', 'html'],
    evidence: { video: 'off', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
    needs: [], volume: 'small: files exist only for tests that failed',
  },
  full: {
    mode: 'full', intendedFor: 'team testing and CI', reporters: ['json', 'html', 'allure'],
    evidence: { video: 'retain-on-failure', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
    needs: ['allure-playwright', 'allure CLI'], volume: 'moderate: Allure results plus videos of failed tests',
  },
  audit: {
    mode: 'audit', intendedFor: 'formal sign-off or audit', reporters: ['json', 'html', 'allure'],
    evidence: { video: 'retain-on-failure', screenshot: 'on', trace: 'retain-on-failure' },
    needs: ['allure-playwright', 'allure CLI'], volume: 'large: a screenshot per test, plus a video per test with the evidence PDF',
  },
};

export interface ModePreset {
  mode: ReportMode;
  reporters: Reporter[];
  evidence: AutomationConfig['evidence'];
  reporting: NonNullable<AutomationConfig['reporting']>;
  needs: string[];
  optIn: { stepScreenshots: boolean; evidencePdf: boolean };
  notes: string[];
}

// What to propose for a mode. Step screenshots and the evidence PDF are opt-in even in audit mode.
export function presetFor(mode: ReportMode, opts: { stepScreenshots?: boolean; evidencePdf?: boolean } = {}): ModePreset {
  const p = MODE_PROFILES[mode];
  const evidencePdf = mode === 'audit' && Boolean(opts.evidencePdf);
  const stepScreenshots = mode === 'audit' && (Boolean(opts.stepScreenshots) || evidencePdf);
  const notes = [`${p.mode}: ${p.intendedFor}; ${p.volume}`];
  if (mode === 'audit' && !stepScreenshots) notes.push('step evidence and the evidence PDF are off: they add files to every test; enable them only for sign-off');
  if (evidencePdf) notes.push('the evidence PDF is rendered with Chromium from the project\'s Playwright; screenshots and videos show visible page data, password fields are masked in the screenshots only');
  // The PDF embeds one video per test, so every test is recorded (not only the failures).
  if (evidencePdf) notes.push('evidence.video is "on" so every test has a video to embed: runs are slower and larger than with failure-only video');
  return {
    mode,
    reporters: [...p.reporters, ...(evidencePdf ? (['evidence-pdf'] as const) : [])],
    evidence: { ...p.evidence, ...(evidencePdf ? { video: 'on' as const } : {}) },
    reporting: { mode, ...(stepScreenshots ? { stepScreenshots: true } : {}) },
    needs: [...p.needs],
    optIn: { stepScreenshots, evidencePdf },
    notes,
  };
}

export interface ReportPlan {
  mode: ReportMode | null; // null = no mode configured: the reporters and evidence are used as chosen
  reporters: Reporter[];
  evidence: AutomationConfig['evidence'];
  stepScreenshots: boolean;
  evidencePdf: boolean;
  // Software the selected reporters need beyond Playwright Test. Resolved against preflight, never installed here.
  requires: { id: string; reporter: Reporter; why: string }[];
  notes: string[];
}

export function reportPlan(config: AutomationConfig): ReportPlan {
  const requires: ReportPlan['requires'] = [];
  if (config.reporters.includes('allure')) {
    requires.push({ id: 'allure-playwright', reporter: 'allure', why: 'writes Allure results from Playwright Test' });
    requires.push({ id: 'allure-cli', reporter: 'allure', why: 'builds the Allure HTML report' });
  }
  if (config.reporters.includes('evidence-pdf')) {
    requires.push({ id: 'browser:chromium', reporter: 'evidence-pdf', why: 'renders the evidence PDF' });
  }
  const mode = config.reporting?.mode ?? null;
  return {
    mode,
    reporters: [...config.reporters],
    evidence: config.evidence,
    stepScreenshots: config.reporting?.stepScreenshots === true,
    evidencePdf: config.reporters.includes('evidence-pdf'),
    requires,
    notes: mode ? [`${mode}: ${MODE_PROFILES[mode].volume}`] : ['no reporting mode is configured; reporters and evidence are used exactly as chosen'],
  };
}
