#!/usr/bin/env node
/**
 * Parallel workspace TypeScript checker (`pnpm typecheck:only`).
 *
 * Runs all independent typecheck roots concurrently (`tsconfig.check.json`,
 * `packages/plugin-client/tsconfig.json`, `packages/plugins/tsconfig.client.json`,
 * `packages/web/tsconfig.json`, `packages/web/tsconfig.test.json`) with per-target
 * buffered output so diagnostics never interleave, and terminates all owned child process trees
 * cleanly on SIGINT/SIGTERM or external AbortSignal.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runManagedCommandDetailed } from './lib/spawn-checked.mjs';

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const defaultTscBin = require.resolve('typescript/bin/tsc');

export const TYPECHECK_TARGETS = [
  { label: 'tsconfig.check.json', project: 'tsconfig.check.json' },
  { label: 'packages/plugin-client/tsconfig.json', project: 'packages/plugin-client/tsconfig.json' },
  { label: 'packages/plugins/tsconfig.client.json', project: 'packages/plugins/tsconfig.client.json' },
  { label: 'packages/web/tsconfig.json', project: 'packages/web/tsconfig.json' },
  { label: 'packages/web/tsconfig.test.json', project: 'packages/web/tsconfig.test.json' },
];

/**
 * Run all workspace typecheck targets concurrently.
 * @param {{ repoRoot?: string, execPath?: string, tscBin?: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal, handleSignals?: boolean }} [options]
 * @returns {Promise<number>}
 */
export async function runParallelTypecheck(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const execPath = options.execPath ?? process.execPath;
  const tscBin = options.tscBin ?? defaultTscBin;
  const env = options.env ?? process.env;
  const externalSignal = options.signal;
  const handleSignals = options.handleSignals ?? true;

  const controller = new AbortController();
  let interruptedCode = null;
  let externalAborted = Boolean(externalSignal?.aborted);
  const onSignal = (sig) => {
    if (interruptedCode !== null) return;
    interruptedCode = sig === 'SIGINT' ? 130 : 143;
    console.error(`[typecheck] received ${sig}, terminating active tsc processes...`);
    controller.abort();
  };
  const onExternalAbort = () => {
    externalAborted = true;
    controller.abort();
  };
  if (handleSignals) {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  try {
    const results = await Promise.all(
      TYPECHECK_TARGETS.map(async (target) => {
        const res = await runManagedCommandDetailed(
          {
            cmd: execPath,
            args: [tscBin, '--noEmit', '-p', path.join(repoRoot, target.project)],
            label: `tsc --noEmit ${target.label}`,
          },
          {
            cwd: repoRoot,
            env,
            capture: true,
            signal: controller.signal,
            handleSignals: false,
          },
        );
        const trimmed = res.output.trim();
        if (res.code !== 0 && interruptedCode === null && !externalAborted) {
          console.error(`[typecheck] ✗ ${target.label} failed (exit ${res.code})${trimmed ? `:\n${trimmed}` : ''}`);
        } else if (trimmed.length > 0 && interruptedCode === null && !externalAborted) {
          process.stdout.write(res.output.endsWith('\n') ? res.output : `${res.output}\n`);
        }
        return { target, ...res };
      }),
    );

    if (interruptedCode !== null) return interruptedCode;
    if (externalAborted) return 143;
    const failed = results.find((r) => r.code !== 0);
    return failed ? failed.code : 0;
  } finally {
    if (handleSignals) {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  const exitCode = await runParallelTypecheck();
  if (exitCode !== 0) process.exit(exitCode);
}
