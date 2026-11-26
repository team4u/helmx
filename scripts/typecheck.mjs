#!/usr/bin/env node
/**
 * Parallel workspace TypeScript checker (`pnpm typecheck:only`).
 *
 * Runs the 3 independent typecheck roots concurrently (`tsconfig.check.json`,
 * `packages/plugins/tsconfig.client.json`, `packages/web/tsconfig.json`) with per-target
 * buffered output so diagnostics never interleave, and terminates all owned child process trees
 * cleanly on SIGINT/SIGTERM.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runManagedCommandDetailed } from './lib/spawn-checked.mjs';

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const defaultTscBin = require.resolve('typescript/bin/tsc');

const TYPECHECK_TARGETS = [
  { label: 'tsconfig.check.json', project: 'tsconfig.check.json' },
  { label: 'packages/plugins/tsconfig.client.json', project: 'packages/plugins/tsconfig.client.json' },
  { label: 'packages/web/tsconfig.json', project: 'packages/web/tsconfig.json' },
  { label: 'packages/web/tsconfig.test.json', project: 'packages/web/tsconfig.test.json' },
];

export async function runParallelTypecheck(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const execPath = options.execPath ?? process.execPath;
  const tscBin = options.tscBin ?? defaultTscBin;
  const env = options.env ?? process.env;

  const controller = new AbortController();
  let interruptedCode = null;
  const onSignal = (sig) => {
    if (interruptedCode !== null) return;
    interruptedCode = sig === 'SIGINT' ? 130 : 143;
    console.error(`[typecheck] received ${sig}, terminating active tsc processes...`);
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

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
        if (res.code !== 0 && interruptedCode === null) {
          console.error(`[typecheck] ✗ ${target.label} failed (exit ${res.code})${trimmed ? `:\n${trimmed}` : ''}`);
        } else if (trimmed.length > 0 && interruptedCode === null) {
          process.stdout.write(res.output.endsWith('\n') ? res.output : `${res.output}\n`);
        }
        return { target, ...res };
      }),
    );

    if (interruptedCode !== null) return interruptedCode;
    const failed = results.find((r) => r.code !== 0);
    return failed ? failed.code : 0;
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
  const exitCode = await runParallelTypecheck();
  if (exitCode !== 0) process.exit(exitCode);
}
