// Deterministic CLI for pipeline state. Agents and skills call this instead of editing
// manifests or config by hand. All output is JSON on stdout.
//
// Exit codes: 0 = ok, 1 = usage/runtime error, 2 = validation failed / not ready.
//
// Usage: node automation/engine/cli/pipeline.ts <group> <action> [args] [--root <dir>]
//   preflight
//   config check | show | save --file <json>
//   run create --command <cmd> [--input <path>]... [--from-run <runId>]
//   run list | show <runId> | resume <runId>
//   run stage <runId> <stage> <status> [--message <text>] [--artifact name=relPath]...
//   run set-config <runId>
//   run counts <runId> --file <json>
//   run healing-attempt <runId> <testId>
//   run finalize <runId>
//   input validate <runId> [--path <p>]          specs parse <runId> [--path <p>]
//   explore validate <runId>                     generate validate <runId>
//   review static <runId> | add <runId> --file <json> | resolve <runId> <id> --status fixed|accepted
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
import { appendDependencyChange, type DependencyChange } from '../pipeline/dependency-log.ts';
import { runPreflight } from '../pipeline/preflight.ts';
import {
  HealingLimitError, createRun, listRuns, loadManifest, prepareResume, recordHealingAttempt,
  recordSetupChange, setRunConfig, setTestCounts, updateStage, type TestCounts,
} from '../pipeline/run-manager.ts';
import { StageContractError } from '../pipeline/stage-contracts.ts';
import { COMMANDS, isStageName, isStageStatus, TransitionError, type Command } from '../pipeline/state-manager.ts';
import { toRootRelative } from '../utils/paths.ts';
import { UsageError, stageCommand } from './stage-commands.ts';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function out(value: unknown, code = 0): number {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  return code;
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
    },
  });
  const root = path.resolve(values.root ?? DEFAULT_ROOT);
  const [group, action, ...rest] = positionals;
  // Accept paths written relative to the caller's cwd (e.g. "automation/input/test-cases/x.md").
  if (values.path) values.path = toRootRelative(root, values.path);
  if (values.input) values.input = values.input.map((p) => toRootRelative(root, p));
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
        return out(result, result.ok ? 0 : 2);
      }
      throw new UsageError('config <check|show|save>');
    }

    case 'run': {
      switch (action) {
        case 'create': {
          const command = need(values.command, '--command') as Command;
          if (!COMMANDS.includes(command)) throw new UsageError(`--command must be one of: ${COMMANDS.join(', ')}`);
          return out(createRun(root, { command, inputPaths: values.input ?? [], sourceRunId: values['from-run'] ?? null }));
        }
        case 'list':
          return out(listRuns(root));
        case 'show': {
          const r = loadManifest(root, need(rest[0], 'runId'));
          return out(r, r.ok ? 0 : 2);
        }
        case 'resume': {
          const r = prepareResume(root, need(rest[0], 'runId'));
          return out(r, r.ok ? 0 : 2);
        }
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
          return out(updateStage(root, need(runId, 'runId'), stage, status, { message: values.message, artifacts }));
        }
        case 'set-config': {
          const state = loadConfig(root);
          if (state.status !== 'valid') return out(state, 2);
          return out(setRunConfig(root, need(rest[0], 'runId'), state.config));
        }
        case 'counts':
          return out(setTestCounts(root, need(rest[0], 'runId'), readJsonArg(values.file) as TestCounts));
        case 'healing-attempt':
          try {
            return out(recordHealingAttempt(root, need(rest[0], 'runId'), need(rest[1], 'testId')));
          } catch (err) {
            if (err instanceof HealingLimitError) return out({ ok: false, limitReached: true, message: err.message }, 2);
            throw err;
          }
        case 'finalize': {
          const r = stageCommand(root, group, action, rest, values);
          return out(r.value, r.code);
        }
        default:
          throw new UsageError('run <create|list|show|resume|stage|set-config|counts|healing-attempt|finalize>');
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

    case 'input': case 'specs': case 'explore': case 'generate': case 'review':
    case 'exec': case 'triage': case 'heal': case 'report': {
      const r = stageCommand(root, group, action, rest, values);
      return out(r.value, r.code);
    }

    default:
      throw new UsageError('usage: pipeline <preflight|config|run|deps|input|specs|explore|generate|review|exec|triage|heal|report> ...');
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
