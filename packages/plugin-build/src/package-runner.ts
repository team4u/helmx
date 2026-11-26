/**
 * Controlled subprocess execution wrapper for plugin package install/update (`npm`, `git`, `tar`).
 */

import { resolveNpmCommand, runControlledProcess, type ResolveNpmCommandIo } from '@helmx/env-io';
import { HelmxError } from '@helmx/protocol';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface PackageRunnerOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputChars?: number;
}

/** Process execution abstraction: spawns npm/git/tar in production; mocked in tests. */
export type PackageRunner = (cmd: string, args: string[], opts: PackageRunnerOptions) => Promise<RunResult>;

/**
 * Create a controlled package runner reusing `@helmx/env-io`'s shell-free process-tree executor:
 * resolves `npm` via `resolveNpmCommand` (handling Windows `npm-cli.js` without `shell: true`),
 * caps captured stdout/stderr per stream, and kills the entire process tree on timeout.
 */
export function createPackageRunner(
  resolveNpm: (io?: ResolveNpmCommandIo) => { command: string; args: string[] } = resolveNpmCommand,
): PackageRunner {
  return async (cmd, args, opts) => {
    const resolved = cmd === 'npm' ? resolveNpm() : { command: cmd, args: [] as string[] };
    const result = await runControlledProcess(resolved.command, [...resolved.args, ...args], {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      ...(opts.maxOutputChars !== undefined ? { maxOutputChars: opts.maxOutputChars } : {}),
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
        GIT_CONFIG_NOSYSTEM: '1',
        npm_config_ignore_scripts: 'true',
        npm_config_foreground_scripts: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false',
        CI: '1',
      },
    });
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    };
  };
}

/** Default runner: non-interactive env, Windows-safe npm spawn, tail-capped output, full process-tree kill on timeout. */
export const defaultPackageRunner: PackageRunner = createPackageRunner();

/** Trailing 40-line snapshot (honesty invariant: external tool failures attach terminal output tail). */
export function tailLines(text: string, lines = 40): string {
  const all = text.split('\n');
  return all.slice(Math.max(0, all.length - lines)).join('\n').trim();
}

export function commandError(kind: 'install' | 'update', cmd: string, args: string[], result: RunResult): HelmxError {
  const statusDetail = result.timedOut === true ? 'timed out and process tree terminated' : `exit ${result.code}`;
  return new HelmxError(
    `plugin_package_${kind}_failed`,
    `plugin package ${kind} command failed: ${cmd} ${args.join(' ')} (${statusDetail})\n${tailLines(result.stderr || result.stdout)}`,
    500,
    {
      cmd,
      args,
      code: result.code,
      ...(result.timedOut === true ? { timedOut: true } : {}),
      ...(result.stdoutTruncated === true ? { stdoutTruncated: true } : {}),
      ...(result.stderrTruncated === true ? { stderrTruncated: true } : {}),
      stdoutTail: tailLines(result.stdout),
      stderrTail: tailLines(result.stderr),
    },
  );
}
