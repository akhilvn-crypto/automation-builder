// Deterministic CLI for pipeline state. Agents and skills call this instead of editing
// manifests or config by hand. All output is JSON on stdout.
//
// Exit codes: 0 = ok, 1 = usage/runtime error, 2 = validation failed / not ready.
//
// Usage: node dependencies/engine/cli/pipeline.ts <group> <action> [args] [--root <dir>]
//   --root is the framework folder (default: the sibling automation/ folder). Test files are relative to it
//   ("tests/login.spec.ts"); test-case input paths are relative to dependencies/ ("input/test-cases").
//   preflight
//   config check | show | save --file <json> | render [--force]
//   config reporter-preset --reporters html,allure,extent,evidence-pdf   what to save for the chosen reports (nothing is saved)
//   config mode-preset <standard|full|audit> [--step-screenshots] [--evidence-pdf]   what a report mode would set (nothing is saved)
//   config report-plan                           configured reporters/mode and the software they need (nothing is installed)
//                                                save writes the choices and refreshes automation/playwright.config.* from them;
//                                                render redoes only that file (it never overwrites a hand-edited one without --force)
// Output is compact JSON (add --pretty to indent). `run create|stage|set-config|counts` print a short status line
// ({ok, runId, status, currentStage, stage}); the full manifest is `run show <runId>`.
//   run create --command <cmd> [--input <path>]... [--from-run <runId>]
//   run list | show <runId> | resume [<runId>] [--command <cmd>]   (no id = newest resumable run)
//   run resumable [--command <cmd>]                                 (checkpoints, newest first)
//   run stage <runId> <stage> <status> [--message <text>] [--artifact name=relPath]...
//   run set-config <runId>
//   run counts <runId> --file <json>
//   run healing-attempt <runId> <testId>
//   run finalize <runId>
//   run metrics <runId> [--write]                per-stage timing/status/artifact sizes, cache and agent use (--write -> metrics.json in the run)
//   run baseline [runId...]                      slowest stages across runs (default: all runs)
//   run compare <baselineRunId> <candidateRunId> same tests + no worse outcome first, then the time difference per stage
//   input validate <runId> [--path <p>]          specs parse <runId> [--path <p>]   (also writes credentials/emails found in the
//                                                  test cases to automation/.env and reports env.missing; names only)
//   input import --from <file-or-folder> [--overwrite]
//                                                convert the user's test cases (any path, any supported layout) into the pipeline's
//                                                Markdown, one file per module, under dependencies/input/test-cases/; credentials found
//                                                go to automation/.env (names only in the output); the original is only read
//   input inspect [--path <p>]                   how CSV/Excel columns, sheets and modules are read (headers only, no cell values)
//   input map <file> [--sheet S] [--column field="Header"]... [--header-row N] [--module M] [--module-from section|sheet|title-prefix] [--skip] [--clear]
//                                                save how a table's columns map to test-case fields (fields: id, title, module,
//                                                preconditions, steps, expected, data, priority, tags)
//   specs modules <runId>                        the module plan: one test file per module, specs to generate and to hold back
//   env check <runId>                            names the specs need that have no value in .env or the environment
//   env run -- <command> [args...]               run a command with automation/.env loaded; secret values masked in the
//                                                JSON output (use single quotes so the child shell expands $VAR, e.g.
//                                                env run -- sh -c 'playwright-cli fill e5 "$TEST_PASSWORD"')
//   explore validate <runId>
//   explore plan <runId> [--fresh|--revalidate]  per test case: explore | revalidate | covered | reuse, with reasons
//   explore revalidate <runId> --page <url|path> --file <snapshot, relative to run dir>
//   explore assemble <runId>                     fresh.json + revalidated saved evidence -> exploration.json
//   explore invalidate <runId> --page <url|path> --reason <text> [--locator <expr>]
//   explore store <runId>                        summary of the saved observations
//   generate plan <runId> [--force] [--no-cache]   per test case: generate | reuse (with reasons) + one batch per module file
//   generate assemble <runId>                    batch manifests + reused tests -> generation-manifest.json
//   generate validate <runId>
//   review static <runId> [--no-cache] | plan <runId> | seal <runId> | add <runId> --file <json> | resolve <runId> <id> --status fixed|accepted
//   cache status <runId>                         hits/misses of the run, and the reason for every rebuild
//   cache inspect <kind> <name>                  one cached artifact's inputs, versions and validation (kind: specs|generation|review|typecheck)
//   agents plan <runId> <stage>                  which stages need an agent (and why), plus its bounded brief in briefs/
//   agents record <runId> <stage> --agent <name> [--input-tokens n --output-tokens n]
//   agents show <runId>                          decisions, invocations and tokens (only when reported)
//   auth check                                   is saved login state safe to reuse? (age, cookies, origin, optional probe; no secrets printed)
//   auth clear                                   remove the saved session so the next run logs in again
//   cleanup run <runId> [--dry-run]              stop what the run left running: its playwright-cli browser sessions (closed first, then
//                                                stopped if they stay) and the processes the pipeline recorded in processes.json.
//                                                Runs by itself when exploration ends, when a stage fails/blocks/cancels, on resume
//                                                and at finalization. Nothing else on the machine is touched.
//   cleanup all [--dry-run]                      the same for every run in dependencies/runs/ (leftovers of crashed or abandoned runs)
//   exec plan <runId>                            workers/isolation the next execution would use, and the login-state decision
//   exec run <runId> [--label L] [--test-file f]... [--test-id id]... [--project p]... [--retries n]
//   triage run <runId> | classify <runId> <key> --category C --confidence C --rationale R
//   heal begin|check|revert|record <runId> <testId> --test-file f [--attempt n] [--rationale R] [--evidence p]...
//   heal finish <runId>                          report build <runId>
//   deps record --dependency <name> --action <action> --reason <text>
//               [--version <v>] [--cmd <command>] [--run <runId>]

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, saveConfig } from '../config/load-config.ts';
import { syncFromSavedConfig } from '../config/playwright-config.ts';
import { REPORT_MODES, type ReportMode } from '../config/schema.ts';
import { appendDependencyChange, type DependencyChange } from '../pipeline/dependency-log.ts';
import { runPreflight } from '../pipeline/preflight.ts';
import { sweepAfterStage, sweepRun, type CleanupBrief } from '../pipeline/process-cleanup.ts';
import { presetFor, presetForReporters, reportPlan } from '../pipeline/reporting-mode.ts';
import {
  HealingLimitError, createRun, listResumable, listRuns, loadManifest, prepareResume, recordHealingAttempt, type RunManifest,
  recordSetupChange, resumeLatest, setRunConfig, setTestCounts, updateStage, type TestCounts,
} from '../pipeline/run-manager.ts';
import { StageContractError } from '../pipeline/stage-contracts.ts';
import { COMMANDS, isStageName, isStageStatus, TransitionError, type Command, type StageName } from '../pipeline/state-manager.ts';
import { inputBaseDir } from '../utils/layout.ts';
import { toRootRelative } from '../utils/paths.ts';
import { UsageError, stageCommand } from './stage-commands.ts';

// dependencies/engine/cli -> dependencies -> <project>/automation
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'automation');

// Output is read by agents, so it is compact; --pretty (or PIPELINE_PRETTY=1) indents it for a human.
let pretty = process.env.PIPELINE_PRETTY === '1';

function out(value: unknown, code = 0): number {
  process.stdout.write(JSON.stringify(value, null, pretty ? 2 : undefined) + '\n');
  return code;
}

// What a state change prints back. The full manifest is `run show <runId>`; echoing it after every
// transition would repeat all 13 stages, the config and the input hashes into the session each time.
function brief(m: RunManifest, stage?: StageName): Record<string, unknown> {
  return {
    ok: true, runId: m.runId, status: m.status, currentStage: m.currentStage,
    ...(stage ? { stage: { name: stage, status: m.stages[stage].status, message: m.stages[stage].message, artifacts: m.stages[stage].artifacts } } : {}),
  };
}

// A resumed run may have been interrupted with a browser session or a runner still going: stop those before continuing.
function withCleanup<T extends { manifest: RunManifest }>(root: string, resumed: T, trigger: string): T & { cleanup?: CleanupBrief } {
  const cleanup = sweepRun(root, resumed.manifest.runId, trigger);
  return cleanup ? { ...resumed, cleanup } : resumed;
}

function readJsonArg(file: string | undefined): unknown {
  if (!file) throw new UsageError('--file <path> is required');
  const text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  return JSON.parse(text.replace(/^﻿/, ''));
}

function need(v: string | undefined, name: string): string {
  if (!v) throw new UsageError(`missing argument: ${name}`);
  return v;
}

export function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      file: { type: 'string' },
      command: { type: 'string' },
      input: { type: 'string', multiple: true },
      message: { type: 'string' },
      artifact: { type: 'string', multiple: true },
      dependency: { type: 'string' },
      action: { type: 'string' },
      reason: { type: 'string' },
      version: { type: 'string' },
      cmd: { type: 'string' },
      run: { type: 'string' },
      'from-run': { type: 'string' },
      path: { type: 'string' },
      label: { type: 'string' },
      'test-id': { type: 'string', multiple: true },
      'test-file': { type: 'string', multiple: true },
      project: { type: 'string', multiple: true },
      retries: { type: 'string' },
      category: { type: 'string' },
      confidence: { type: 'string' },
      rationale: { type: 'string' },
      evidence: { type: 'string', multiple: true },
      attempt: { type: 'string' },
      status: { type: 'string' },
      note: { type: 'string' },
      column: { type: 'string', multiple: true },
      sheet: { type: 'string' },
      'header-row': { type: 'string' },
      module: { type: 'string' },
      'module-from': { type: 'string' },
      skip: { type: 'boolean' },
      clear: { type: 'boolean' },
      from: { type: 'string' },
      overwrite: { type: 'boolean' },
      force: { type: 'boolean' },
      pretty: { type: 'boolean' },
      write: { type: 'boolean' },
      fresh: { type: 'boolean' },
      revalidate: { type: 'boolean' },
      page: { type: 'string' },
      locator: { type: 'string' },
      'no-cache': { type: 'boolean' },
      agent: { type: 'string' },
      'input-tokens': { type: 'string' },
      'output-tokens': { type: 'string' },
      'step-screenshots': { type: 'boolean' },
      'evidence-pdf': { type: 'boolean' },
      reporters: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
  });
  if (values.pretty) pretty = true;
  const root = path.resolve(values.root ?? DEFAULT_ROOT);
  const [group, action, ...rest] = positionals;
  // Accept paths written relative to the caller's cwd (e.g. "dependencies/input/test-cases/x.md" from the project root).
  const inputBase = inputBaseDir(root);
  if (values.path) values.path = toRootRelative(inputBase, values.path);
  if (values.input) values.input = values.input.map((p) => toRootRelative(inputBase, p));
  if (values['test-file']) values['test-file'] = values['test-file'].map((p) => toRootRelative(root, p));

  switch (group) {
    case 'preflight': {
      const report = runPreflight(root);
      return out(report, report.ready ? 0 : 2);
    }

    case 'config': {
      if (action === 'check' || action === 'show') {
        const state = loadConfig(root);
        return out(state, state.status === 'valid' ? 0 : 2);
      }
      if (action === 'save') {
        const result = saveConfig(root, readJsonArg(values.file));
        // The saved choices also go into playwright.config.* (unless it was edited by hand).
        return out(result.ok ? { ...result, playwrightConfig: syncFromSavedConfig(root) } : result, result.ok ? 0 : 2);
      }
      if (action === 'render') {
        const result = syncFromSavedConfig(root, { force: values.force === true });
        if (!result) return out(loadConfig(root, { env: {} }), 2);
        return out({ ok: result.status !== 'kept', playwrightConfig: result }, result.status === 'kept' ? 2 : 0);
      }
      // What a report mode would set (reporters, evidence, the software it needs). Nothing is saved or installed.
      if (action === 'mode-preset') {
        const mode = need(rest[0], 'mode') as ReportMode;
        if (!REPORT_MODES.includes(mode)) throw new UsageError(`mode must be one of: ${REPORT_MODES.join(', ')}`);
        return out({ ok: true, ...presetFor(mode, { stepScreenshots: values['step-screenshots'], evidencePdf: values['evidence-pdf'] }) });
      }
      // What to save for the reports the user picked (html, allure, extent, evidence-pdf; json is always added). Nothing is saved or installed.
      if (action === 'reporter-preset') {
        // "none" = no report beyond the JSON results the pipeline itself reads.
        const selected = need(values.reporters, '--reporters').split(',').map((s) => s.trim()).filter((s) => s && s !== 'none');
        try {
          return out({ ok: true, selected, ...presetForReporters(selected) });
        } catch (err) {
          throw new UsageError(err instanceof Error ? err.message : String(err));
        }
      }
      // The configured reporters and mode, with the status of the software they need. Missing software is never installed here.
      if (action === 'report-plan') {
        const state = loadConfig(root);
        if (state.status !== 'valid') return out(state, 2);
        const plan = reportPlan(state.config);
        const checks = runPreflight(root).checks;
        const requires = plan.requires.map((r) => {
          const c = checks.find((x) => x.id === r.id);
          return { ...r, status: c?.status ?? 'unknown', installCommand: c?.status === 'ok' ? null : c?.installCommand ?? null };
        });
        const missing = requires.filter((r) => r.status !== 'ok');
        return out({ ok: missing.length === 0, ...plan, requires, missing: missing.map((m) => m.id), approvalNeeded: missing.length > 0 ? 'ask the user before installing each missing item, one at a time' : null }, missing.length === 0 ? 0 : 2);
      }
      throw new UsageError('config <check|show|save|render [--force]|reporter-preset|mode-preset|report-plan>');
    }

    case 'run': {
      switch (action) {
        case 'create': {
          const command = need(values.command, '--command') as Command;
          if (!COMMANDS.includes(command)) throw new UsageError(`--command must be one of: ${COMMANDS.join(', ')}`);
          const m = createRun(root, { command, inputPaths: values.input ?? [], sourceRunId: values['from-run'] ?? null });
          return out({ ...brief(m), command: m.command, sourceRunId: m.sourceRunId ?? null, inputFiles: m.inputs.length });
        }
        case 'list':
          return out(listRuns(root));
        case 'show': {
          const r = loadManifest(root, need(rest[0], 'runId'));
          return out(r, r.ok ? 0 : 2);
        }
        case 'resume': {
          // No run id: continue the newest resumable run (optionally of one --command).
          if (rest[0] === undefined) {
            const command = values.command as Command | undefined;
            if (command !== undefined && !COMMANDS.includes(command)) throw new UsageError(`--command must be one of: ${COMMANDS.join(', ')}`);
            const r = resumeLatest(root, command);
            return out(r.ok ? withCleanup(root, r, 'resume') : r, r.ok ? 0 : 2);
          }
          const r = prepareResume(root, rest[0]);
          return out(r.ok ? withCleanup(root, r, 'resume') : r, r.ok ? 0 : 2);
        }
        case 'resumable':
          return out(listResumable(root, values.command as Command | undefined));
        case 'stage': {
          const [runId, stage, status] = rest;
          if (!isStageName(stage)) throw new UsageError(`unknown stage ${JSON.stringify(stage)}`);
          if (!isStageStatus(status)) throw new UsageError(`unknown status ${JSON.stringify(status)}`);
          const artifacts: Record<string, string> = {};
          for (const a of values.artifact ?? []) {
            const eq = a.indexOf('=');
            if (eq <= 0) throw new UsageError(`--artifact must be name=relPath (got "${a}")`);
            artifacts[a.slice(0, eq)] = a.slice(eq + 1);
          }
          const updated = updateStage(root, need(runId, 'runId'), stage, status, { message: values.message, artifacts });
          // The state change is already saved; a cleanup that finds nothing prints nothing.
          const cleanup = sweepAfterStage(root, updated.runId, stage, status);
          return out({ ...brief(updated, stage), ...(cleanup ? { cleanup } : {}) });
        }
        case 'set-config': {
          const state = loadConfig(root);
          if (state.status !== 'valid') return out(state, 2);
          return out(brief(setRunConfig(root, need(rest[0], 'runId'), state.config)));
        }
        case 'counts': {
          const m = setTestCounts(root, need(rest[0], 'runId'), readJsonArg(values.file) as TestCounts);
          return out({ ...brief(m), testCounts: m.testCounts });
        }
        case 'healing-attempt':
          try {
            return out(recordHealingAttempt(root, need(rest[0], 'runId'), need(rest[1], 'testId')));
          } catch (err) {
            if (err instanceof HealingLimitError) return out({ ok: false, limitReached: true, message: err.message }, 2);
            throw err;
          }
        case 'finalize': case 'metrics': case 'baseline': case 'compare': {
          const r = stageCommand(root, group, action, rest, values);
          return out(r.value, r.code);
        }
        default:
          throw new UsageError('run <create|list|show|resume|resumable|stage|set-config|counts|healing-attempt|finalize|metrics|baseline|compare>');
      }
    }

    case 'deps': {
      if (action !== 'record') throw new UsageError('deps record ...');
      const change: DependencyChange = {
        timestamp: new Date().toISOString(),
        dependency: need(values.dependency, '--dependency'),
        action: need(values.action, '--action') as DependencyChange['action'],
        version: values.version ?? null,
        command: values.cmd ?? null,
        reason: need(values.reason, '--reason'),
        runId: values.run ?? null,
      };
      appendDependencyChange(root, change);
      if (change.runId) recordSetupChange(root, change.runId, change);
      return out({ ok: true, recorded: change });
    }

    case 'input': case 'specs': case 'env': case 'explore': case 'generate': case 'review':
    case 'exec': case 'triage': case 'heal': case 'report': case 'agents': case 'cache': case 'auth': case 'cleanup': {
      const r = stageCommand(root, group, action, rest, values);
      return out(r.value, r.code);
    }

    default:
      throw new UsageError('usage: pipeline <preflight|config|run|deps|input|specs|env|explore|generate|review|exec|triage|heal|report|agents|cache|auth|cleanup> ...');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    const kind = err instanceof UsageError ? 'usage'
      : err instanceof TransitionError ? 'transition'
      : err instanceof StageContractError ? 'contract'
      : 'error';
    process.stderr.write(JSON.stringify({ ok: false, kind, message: (err as Error).message }) + '\n');
    process.exitCode = 1;
  }
}
