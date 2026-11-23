#!/usr/bin/env node
/**
 * Shared pre-build incremental dist cleaner (`pruneDist` wrapper).
 *
 * Invoked from workspace package `build` scripts (`node ../../scripts/clean-dist.mjs`), where
 * `process.cwd()` is the package root. Also accepts `--pkg-root <dir>` and `--preserve-clients`.
 */
import path from 'node:path';
import { runCleanDistCli } from './lib/prune-dist.mjs';

const argv = process.argv.slice(2);
let pkgRoot = process.cwd();
let preserveClients = false;
const passArgs = [];

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--pkg-root' && argv[i + 1]) {
    pkgRoot = path.resolve(argv[i + 1]);
    i += 1;
  } else if (arg.startsWith('--pkg-root=')) {
    pkgRoot = path.resolve(arg.slice('--pkg-root='.length));
  } else if (arg === '--preserve-clients') {
    preserveClients = true;
  } else {
    passArgs.push(arg);
  }
}

runCleanDistCli(pkgRoot, passArgs, { preserveClients });
