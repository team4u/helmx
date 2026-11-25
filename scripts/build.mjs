#!/usr/bin/env node
/**
 * Unified DAG workspace build orchestrator for helmx.
 *
 * Replaces `pnpm -r build` (whose devDependencies edges serialized kernel -> plugins -> web across
 * 7 waves and spawned 8 independent tsc processes). Uses TypeScript project references (`tsc -b`)
 * concurrently with independent frontend/asset stages, and reuses `pruneDist` in-process.
 *
 * Usage:
 *   node scripts/build.mjs                  # Full workspace build (backend + web + plugin clients + sdk-types + payload)
 *   node scripts/build.mjs --skip-payload   # Everything except packages/payload (for CI/test/Docker)
 *   node scripts/build.mjs --for-typecheck  # 7 backend runtime packages (excluding cli) + plugin clients
 *   node scripts/build.mjs --unit-deps      # Minimal unit-tier build (protocol + env-io + plugin-build)
 *   node scripts/build.mjs --force | -f     # Clean wipe & rebuild (or HELMX_CLEAN_DIST=1)
 *
 * Exit codes: 0 success; non-zero child exit code on failure; 2 on CLI usage errors.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneDist } from './lib/prune-dist.mjs';
import { runManagedCommandDetailed } from './lib/spawn-checked.mjs';
import { pruneStalePluginDistDirs } from '../packages/plugins/scripts/clean-dist.mjs';

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const defaultTscBin = require.resolve('typescript/bin/tsc');

const ALL_BACKEND_PACKAGES = ['protocol', 'env-io', 'node', 'plugin-build', 'kernel', 'plugins', 'hub', 'cli'];
const TYPECHECK_BACKEND_PACKAGES = ['protocol', 'env-io', 'node', 'plugin-build', 'kernel', 'plugins', 'hub'];
const UNIT_DEPS_PACKAGES = ['protocol', 'env-io', 'plugin-build'];
const BUILD_MODES = new Set(['full', 'skip-payload', 'for-typecheck', 'unit-deps']);

export function buildUsageText() {
  return `Usage: node scripts/build.mjs [--skip-payload | --for-typecheck | --unit-deps] [--force|-f] [--quiet|-q]
  --skip-payload   Build all runtime packages, web, plugin clients, and CLI SDK types (skip payload packaging)
  --for-typecheck  Build 7 backend runtime packages (hub + node closures, excluding cli) and plugin clients
  --unit-deps      Build unit-tier dependency closure (protocol, env-io, plugin-build)
  --force, -f      Force full wipe and rebuild (equivalent to HELMX_CLEAN_DIST=1)
  --quiet, -q      Suppress non-error build summary output`;
}

export class BuildArgError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BuildArgError';
  }
}

/**
 * Parse CLI arguments for `scripts/build.mjs`.
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ mode: 'full' | 'skip-payload' | 'for-typecheck' | 'unit-deps', force: boolean, quiet: boolean }}
 */
export function parseBuildArgs(argv = [], env = process.env) {
  let mode = null;
  let force = env.HELMX_CLEAN_DIST === '1';
  let quiet = false;

  const setMode = (nextMode, flag) => {
    if (mode !== null && mode !== nextMode) {
      throw new BuildArgError(`Conflicting build mode flags: --${mode} and ${flag} cannot be combined`);
    }
    mode = nextMode;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--' && i === 0) continue;
    if (arg === '--skip-payload') setMode('skip-payload', arg);
    else if (arg === '--for-typecheck') setMode('for-typecheck', arg);
    else if (arg === '--unit-deps') setMode('unit-deps', arg);
    else if (arg === '--force' || arg === '-f') force = true;
    else if (arg === '--quiet' || arg === '-q') quiet = true;
    else throw new BuildArgError(`Unknown argument: ${arg}`);
  }

  return { mode: mode ?? 'full', force, quiet };
}

/**
 * Pure DAG stage planner for workspace builds (shared by execution and unit tests).
 * @param {{ repoRoot?: string, execPath?: string, tscBin?: string, mode?: 'full' | 'skip-payload' | 'for-typecheck' | 'unit-deps', force?: boolean, quiet?: boolean }} [options]
 */
export function planBuildStages(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const execPath = options.execPath ?? process.execPath;
  const tscBin = options.tscBin ?? defaultTscBin;
  const mode = options.mode ?? 'full';
  const force = options.force === true;
  const quiet = options.quiet === true;

  if (!BUILD_MODES.has(mode)) {
    throw new BuildArgError(`Unsupported build mode: ${mode}`);
  }

  const forceArgs = force ? ['--force'] : [];
  const quietArgs = quiet ? ['--quiet'] : [];

  if (mode === 'unit-deps') {
    return {
      mode,
      force,
      cleanPackages: [...UNIT_DEPS_PACKAGES],
      tscCommand: {
        cmd: execPath,
        args: [tscBin, '-b', 'packages/plugin-build', ...forceArgs],
        label: 'tsc -b packages/plugin-build',
      },
      webCommand: null,
      postTscCommands: [],
      payloadCommand: null,
    };
  }

  if (mode === 'for-typecheck') {
    return {
      mode,
      force,
      cleanPackages: [...TYPECHECK_BACKEND_PACKAGES],
      tscCommand: {
        cmd: execPath,
        args: [tscBin, '-b', 'packages/hub', 'packages/node', ...forceArgs],
        label: 'tsc -b packages/hub packages/node',
      },
      webCommand: null,
      postTscCommands: [
        {
          cmd: execPath,
          args: [path.join(repoRoot, 'packages/plugins/scripts/copy-plugin-clients.mjs'), ...forceArgs, ...quietArgs],
          label: 'copy-plugin-clients',
        },
      ],
      payloadCommand: null,
    };
  }

  return {
    mode,
    force,
    cleanPackages: [...ALL_BACKEND_PACKAGES],
    tscCommand: {
      cmd: execPath,
      args: [tscBin, '-b', 'tsconfig.build.json', ...forceArgs],
      label: 'tsc -b tsconfig.build.json',
    },
    webCommand: {
      cmd: execPath,
      args: [path.join(repoRoot, 'packages/web/scripts/build-web.mjs'), ...forceArgs, ...quietArgs],
      label: 'build-web',
    },
    postTscCommands: [
      {
        cmd: execPath,
        args: [path.join(repoRoot, 'packages/plugins/scripts/copy-plugin-clients.mjs'), ...forceArgs, ...quietArgs],
        label: 'copy-plugin-clients',
      },
      {
        cmd: execPath,
        args: [path.join(repoRoot, 'packages/cli/scripts/generate-sdk-types.mjs'), ...forceArgs],
        label: 'generate-sdk-types',
      },
      {
        cmd: execPath,
        args: [tscBin, '--noEmit', '-p', path.join(repoRoot, 'packages/plugin-client/tsconfig.json')],
        label: 'tsc --noEmit plugin-client',
      },
    ],
    payloadCommand:
      mode === 'full'
        ? {
            cmd: execPath,
            args: [path.join(repoRoot, 'packages/payload/build.mjs'), ...forceArgs],
            label: 'build-payload',
          }
        : null,
  };
}

function flushCommandOutput(command, res, quiet) {
  const trimmed = res.output.trim();
  if (trimmed.length === 0) return;
  if (res.code !== 0) {
    console.error(`[build] ${command.label} failed (exit ${res.code}):\n${trimmed}`);
  } else if (!quiet) {
    process.stdout.write(res.output.endsWith('\n') ? res.output : `${res.output}\n`);
  }
}

/**
 * Execute the planned DAG workspace build.
 * @param {{ repoRoot?: string, execPath?: string, tscBin?: string, mode?: 'full' | 'skip-payload' | 'for-typecheck' | 'unit-deps', force?: boolean, quiet?: boolean, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<number>}
 */
export async function runBuild(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const env = options.env ?? process.env;
  const quiet = options.quiet === true;
  const plan = planBuildStages(options);

  // Pre-clean stale dist outputs and honor HELMX_CLEAN_DIST / --force before tsc -b inspects tsbuildinfo.
  for (const pkg of plan.cleanPackages) {
    const pkgRoot = path.join(repoRoot, 'packages', pkg);
    const preserveClients = pkg === 'plugins';
    if (preserveClients && !plan.force) {
      pruneStalePluginDistDirs(pkgRoot);
    }
    pruneDist({
      pkgRoot,
      preserveClients,
      force: plan.force,
      env,
    });
  }

  const controller = new AbortController();
  let interruptedCode = null;
  const onSignal = (sig) => {
    if (interruptedCode !== null) return;
    interruptedCode = sig === 'SIGINT' ? 130 : 143;
    console.error(`[build] received ${sig}, terminating active build processes...`);
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const runStep = async (cmd) => {
    const res = await runManagedCommandDetailed(cmd, {
      cwd: repoRoot,
      env,
      capture: true,
      signal: controller.signal,
      handleSignals: false,
    });
    if (interruptedCode === null || res.code !== 0) {
      flushCommandOutput(cmd, res, quiet);
    }
    return res.code;
  };

  try {
    let firstFailureCode = 0;
    const recordFailure = (code) => {
      if (code !== 0 && firstFailureCode === 0) {
        firstFailureCode = code;
        controller.abort();
      }
      return code;
    };

    const webPromise = plan.webCommand
      ? runStep(plan.webCommand).then(recordFailure)
      : Promise.resolve(0);

    const backendPromise = (async () => {
      const tscCode = recordFailure(await runStep(plan.tscCommand));
      if (tscCode !== 0) return tscCode;
      if (plan.postTscCommands.length === 0) return 0;
      const postCodes = await Promise.all(
        plan.postTscCommands.map((cmd) => runStep(cmd).then(recordFailure)),
      );
      return postCodes.find((c) => c !== 0) ?? 0;
    })();

    const [webCode, backendCode] = await Promise.all([webPromise, backendPromise]);
    if (interruptedCode !== null) return interruptedCode;
    if (firstFailureCode !== 0 || webCode !== 0 || backendCode !== 0) {
      return firstFailureCode || backendCode || webCode;
    }

    if (plan.payloadCommand) {
      const payloadCode = await runStep(plan.payloadCommand);
      if (interruptedCode !== null) return interruptedCode;
      if (payloadCode !== 0) return payloadCode;
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
    parsed = parseBuildArgs(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(`[build] ${err instanceof Error ? err.message : String(err)}`);
    console.error(buildUsageText());
    process.exit(2);
  }
  const exitCode = await runBuild(parsed);
  if (exitCode !== 0) process.exit(exitCode);
}
