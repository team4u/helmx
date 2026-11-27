#!/usr/bin/env node
/**
 * Parallel verification DAG orchestrator (`pnpm verify`).
 *
 * Replaces the 5-stage serial `&&` chain (`build && typecheck:only && lint && check:hygiene &&
 * test:all:run`) with a two-phase pipeline:
 * - Phase 1 (build + static gates DAG): starts `tsc -b tsconfig.build.json`, `build-web`,
 *   `oxlint`, and `check:hygiene` concurrently at t=0; once `tsc -b` succeeds, immediately starts
 *   post-tsc generators (`copy-plugin-clients`, `generate-sdk-types`) alongside `typecheck:only`;
 *   once `build-web` and post-tsc generators finish, runs `build-payload` concurrently with any
 *   remaining `typecheck:only` work. Never starts tests if Phase 1 fails.
 * - Phase 2 (all tests): gives `test-suites.mjs all` exclusive access to all worker cores once
 *   Phase 1 passes (zero CPU contention with Vite/tsc/esbuild).
 *
 * Usage:
 *   node scripts/verify.mjs [--force|-f] [--skip-tests] [--quiet|-q]
 *
 * Exit codes: 0 success; non-zero child/stage exit code on failure; 2 on CLI usage errors.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planBuildStages, prepareBuildDist } from './build.mjs';
import { runParallelTypecheck } from './typecheck.mjs';
import { runManagedCommandDetailed } from './lib/spawn-checked.mjs';

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const defaultTscBin = require.resolve('typescript/bin/tsc');
const defaultOxlintBin = path.join(path.dirname(require.resolve('oxlint/package.json')), 'bin', 'oxlint');

export function verifyUsageText() {
  return `Usage: node scripts/verify.mjs [--force|-f] [--skip-tests] [--quiet|-q]
  --force, -f   Force clean dist rebuild (equivalent to HELMX_CLEAN_DIST=1)
  --skip-tests  Run build + static gates DAG only (skip Phase 2 test suite)
  --quiet, -q   Suppress non-error Phase 1 output and timing summary`;
}

export class VerifyArgError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VerifyArgError';
  }
}

/**
 * Parse CLI arguments for `scripts/verify.mjs`.
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ force: boolean, skipTests: boolean, quiet: boolean }}
 */
export function parseVerifyArgs(argv = [], env = process.env) {
  let force = env.HELMX_CLEAN_DIST === '1';
  let skipTests = false;
  let quiet = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--' && i === 0) continue;
    if (arg === '--force' || arg === '-f') force = true;
    else if (arg === '--skip-tests') skipTests = true;
    else if (arg === '--quiet' || arg === '-q') quiet = true;
    else throw new VerifyArgError(`Unknown argument: ${arg}`);
  }

  return { force, skipTests, quiet };
}

/**
 * Pure verification DAG planner (shared by execution and unit tests).
 * @param {{ repoRoot?: string, execPath?: string, tscBin?: string, oxlintBin?: string, force?: boolean, skipTests?: boolean, quiet?: boolean }} [options]
 */
export function planVerifyStages(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const execPath = options.execPath ?? process.execPath;
  const tscBin = options.tscBin ?? defaultTscBin;
  const oxlintBin = options.oxlintBin ?? defaultOxlintBin;
  const force = options.force === true;
  const skipTests = options.skipTests === true;
  const quiet = options.quiet === true;

  const buildPlan = planBuildStages({
    repoRoot,
    execPath,
    tscBin,
    mode: 'full',
    force,
    quiet,
  });

  return {
    force,
    skipTests,
    quiet,
    buildPlan,
    lintCommand: {
      cmd: execPath,
      args: [oxlintBin],
      label: 'lint',
    },
    hygieneCommand: {
      cmd: execPath,
      args: [path.join(repoRoot, 'scripts', 'check-test-hygiene.mjs')],
      label: 'check:hygiene',
    },
    testsCommand: skipTests
      ? null
      : {
          cmd: execPath,
          args: [path.join(repoRoot, 'scripts', 'test-suites.mjs'), 'all'],
          label: 'test:all',
        },
  };
}

function flushStepOutput(command, res, quiet, interrupted) {
  if (interrupted) return;
  const trimmed = res.output.trim();
  if (trimmed.length === 0) return;
  if (res.code !== 0) {
    console.error(`[verify] ✗ ${command.label} failed (exit ${res.code}):\n${trimmed}`);
  } else if (!quiet) {
    process.stdout.write(res.output.endsWith('\n') ? res.output : `${res.output}\n`);
  }
}

function formatDurationSec(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Execute the full two-phase verification DAG.
 * @param {{ repoRoot?: string, execPath?: string, tscBin?: string, oxlintBin?: string, force?: boolean, skipTests?: boolean, quiet?: boolean, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<number>}
 */
export async function runVerify(options = {}) {
  const totalStart = Date.now();
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const execPath = options.execPath ?? process.execPath;
  const tscBin = options.tscBin ?? defaultTscBin;
  const env = options.env ?? process.env;
  const plan = planVerifyStages(options);
  const { buildPlan, quiet } = plan;

  prepareBuildDist(repoRoot, buildPlan, env);

  const controller = new AbortController();
  let interruptedCode = null;
  let firstFailureCode = 0;

  const onSignal = (sig) => {
    if (interruptedCode !== null) return;
    interruptedCode = sig === 'SIGINT' ? 130 : 143;
    console.error(`[verify] received ${sig}, terminating active verification processes...`);
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const recordFailure = (code) => {
    if (code !== 0 && firstFailureCode === 0) {
      firstFailureCode = code;
      controller.abort();
    }
    return code;
  };

  /** @type {Record<string, number>} */
  const timingsMs = {};

  const runBufferedStep = async (key, command) => {
    const start = Date.now();
    const res = await runManagedCommandDetailed(command, {
      cwd: repoRoot,
      env,
      capture: true,
      signal: controller.signal,
      handleSignals: false,
    });
    timingsMs[key] = Date.now() - start;
    // Check abort status before recordFailure so the first failing step prints its diagnostics
    // while already-aborted sibling steps do not spam secondary cancellation errors.
    const alreadyAborted = controller.signal.aborted || interruptedCode !== null;
    if (res.code !== 0) {
      if (!alreadyAborted) flushStepOutput(command, res, quiet, false);
      return recordFailure(res.code);
    }
    flushStepOutput(command, res, quiet, alreadyAborted);
    return 0;
  };

  try {
    const phase1Start = Date.now();

    const lintPromise = runBufferedStep('lint', plan.lintCommand);
    const hygienePromise = runBufferedStep('hygiene', plan.hygieneCommand);
    const webPromise = buildPlan.webCommand ? runBufferedStep('web', buildPlan.webCommand) : Promise.resolve(0);

    let typecheckPromise = Promise.resolve(0);
    let tscDoneResolve;
    let tscDone = false;

    const tscAndTypecheckPromise = (async () => {
      const tscCode = await runBufferedStep('tsc', buildPlan.tscCommand);
      if (tscCode !== 0 || controller.signal.aborted) {
        tscDone = true;
        tscDoneResolve?.(tscCode || 143);
        return tscCode;
      }

      typecheckPromise = (async () => {
        const tcStart = Date.now();
        const alreadyAborted = controller.signal.aborted || interruptedCode !== null;
        if (alreadyAborted) return 143;
        const code = await runParallelTypecheck({
          repoRoot,
          execPath,
          tscBin,
          env,
          signal: controller.signal,
          handleSignals: false,
        });
        timingsMs.typecheck = Date.now() - tcStart;
        if (code !== 0) return recordFailure(code);
        return 0;
      })();

      const postStart = Date.now();
      const postCodes = await Promise.all(
        buildPlan.postTscCommands.map((cmd, idx) => runBufferedStep(`postTsc_${idx}`, cmd)),
      );
      timingsMs.postTsc = Date.now() - postStart;
      const postCode = postCodes.find((c) => c !== 0) ?? 0;
      tscDone = true;
      tscDoneResolve?.(postCode);

      const tcCode = await typecheckPromise;
      return postCode || tcCode;
    })();

    const waitPostTsc = new Promise((resolve) => {
      if (tscDone) resolve(0);
      else tscDoneResolve = resolve;
    });

    const payloadPromise = (async () => {
      const [webCode, postCode] = await Promise.all([webPromise, waitPostTsc]);
      if (webCode !== 0 || postCode !== 0 || controller.signal.aborted || !buildPlan.payloadCommand) {
        return webCode || postCode;
      }
      return await runBufferedStep('payload', buildPlan.payloadCommand);
    })();

    const phase1Codes = await Promise.all([lintPromise, hygienePromise, tscAndTypecheckPromise, payloadPromise]);
    timingsMs.phase1 = Date.now() - phase1Start;

    if (interruptedCode !== null) return interruptedCode;
    const phase1Fail = firstFailureCode || phase1Codes.find((c) => c !== 0) || 0;
    if (phase1Fail !== 0) return phase1Fail;

    if (plan.testsCommand) {
      const testStart = Date.now();
      const testRes = await runManagedCommandDetailed(plan.testsCommand, {
        cwd: repoRoot,
        env,
        capture: false,
        signal: controller.signal,
        handleSignals: false,
      });
      timingsMs.tests = Date.now() - testStart;
      if (interruptedCode !== null) return interruptedCode;
      if (testRes.code !== 0) return testRes.code;
    }

    timingsMs.total = Date.now() - totalStart;
    if (!quiet) {
      const parts = [
        `phase1=${formatDurationSec(timingsMs.phase1)}`,
        ...(timingsMs.tsc !== undefined ? [`tsc=${formatDurationSec(timingsMs.tsc)}`] : []),
        ...(timingsMs.web !== undefined ? [`web=${formatDurationSec(timingsMs.web)}`] : []),
        ...(timingsMs.postTsc !== undefined ? [`post-tsc=${formatDurationSec(timingsMs.postTsc)}`] : []),
        ...(timingsMs.payload !== undefined ? [`payload=${formatDurationSec(timingsMs.payload)}`] : []),
        ...(timingsMs.typecheck !== undefined ? [`typecheck=${formatDurationSec(timingsMs.typecheck)}`] : []),
        ...(timingsMs.lint !== undefined ? [`lint=${formatDurationSec(timingsMs.lint)}`] : []),
        ...(timingsMs.hygiene !== undefined ? [`hygiene=${formatDurationSec(timingsMs.hygiene)}`] : []),
        ...(timingsMs.tests !== undefined ? [`tests=${formatDurationSec(timingsMs.tests)}`] : []),
      ];
      console.error(`[verify] ✓ all checks passed in ${formatDurationSec(timingsMs.total)} (${parts.join(', ')})`);
    }
    return 0;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  let parsed;
  try {
    parsed = parseVerifyArgs(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(`[verify] ${err instanceof Error ? err.message : String(err)}`);
    console.error(verifyUsageText());
    process.exit(2);
  }
  const exitCode = await runVerify(parsed);
  if (exitCode !== 0) process.exit(exitCode);
}
