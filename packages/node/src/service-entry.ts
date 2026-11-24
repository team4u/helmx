/**
 * Resolves CLI entrypoints and runtime install mode:
 * - `detectNodeInstallMode()` distinguishes source/link checkouts (`source`) from published/staged
 *   npm release artifacts (`release`) strictly by module/package layout (never by package version);
 * - `cliSelfEntry()` resolves this package's own CLI entrypoint (`src/cli.ts` or `dist/cli.js`);
 * - `resolveServiceEntry()` resolves compiled `dist/cli.js` for OS startup services.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import type { NodeInstallMode } from '@helmx/protocol';
import { UsageError } from './cli-context.js';

export const SOURCE_MODE_UPGRADE_MESSAGE =
  'not_supported (source_mode): helmx-node is running in source/link mode; npm self-upgrade is disabled — update the source repository and restart helmx-node manually';

/**
 * Detect whether `@helmx/node` is running from a source/link checkout (`source`) or a published /
 * staged npm release artifact (`release`).
 *
 * Rules (never inferred from package version):
 * 1. TypeScript module paths (`.ts` / `.mts` / `.cts`, e.g. `link-bins` -> `tsx` -> `src/cli.ts`)
 *    are always `source`;
 * 2. Compiled JS inside a package root that still contains `src/cli.ts` or declares `"private": true`
 *    (e.g. repo `packages/node/dist/cli.js` / `npm link`) is `source`;
 * 3. Published npm bundles (`npm install -g @helmx/node`, staged `releases/<ver>/...`, or assembled
 *    `dist-node/dist/cli.js`) have none of those markers and resolve to `release`.
 */
export function detectNodeInstallMode(selfPath: string = fileURLToPath(import.meta.url)): NodeInstallMode {
  let resolved = path.resolve(selfPath);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // Path may be synthetic in tests; fall back to lexical resolution.
  }
  const ext = path.extname(resolved).toLowerCase();
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
    return 'source';
  }
  let dir = path.dirname(resolved);
  for (let depth = 0; depth < 3; depth += 1) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      if (fs.existsSync(path.join(dir, 'src', 'cli.ts'))) return 'source';
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
          private?: unknown;
        };
        if (pkg.private === true) return 'source';
      } catch {
        // Malformed/unreadable package.json: do not fabricate source mode.
      }
      return 'release';
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'release';
}

/**
 * Resolve this package's own CLI entrypoint (`src/cli.ts` in source mode, `dist/cli.js` when built).
 */
export function cliSelfEntry(): string {
  const self = path.resolve(fileURLToPath(import.meta.url));
  const cli = path.resolve(path.dirname(self), 'cli.ts');
  if (fs.existsSync(cli)) return cli;
  return path.resolve(path.dirname(self), '..', 'dist', 'cli.js');
}

/**
 * Resolve the compiled entrypoint (`dist/cli.js`) required by OS service managers (which lack tsx).
 * Throws `missing_build` if running from source without compiled `dist/cli.js`.
 */
export function resolveServiceEntry(selfPath: string = fileURLToPath(import.meta.url)): string {
  const self = path.resolve(selfPath);
  if (self.endsWith(path.join('dist', 'cli.js'))) return self;
  const distEntry = path.resolve(path.dirname(self), '..', 'dist', 'cli.js');
  try {
    return realpathSync(distEntry);
  } catch {
    throw new UsageError(
      `service entrypoint must be the compiled artifact (${distEntry}), which was not found while running from source; run pnpm build in the repository first`,
      'missing_build',
    );
  }
}
