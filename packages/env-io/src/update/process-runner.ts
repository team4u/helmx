/**
 * Shared controlled subprocess execution primitives (`@helmx/env-io`):
 * - Shell-free `spawn(..., { shell: false })` with `windowsHide: true`;
 * - Windows `npm` entrypoint resolution (`node_modules/npm/bin/npm-cli.js` beside `process.execPath`),
 *   avoiding both `npm.cmd` direct-spawn failures and unsafe `shell: true` interpolation;
 * - Strict per-stream tail-retaining output cap (`stdout` / `stderr`) so noisy tools cannot OOM the host
 *   while preserving trailing diagnostic lines;
 * - Hard timeout terminating the entire process tree via `killProcessTree` (POSIX process group `SIGKILL`
 *   with `detached: true`; Windows `taskkill /F /T`) and settling immediately without waiting on orphans.
 */
import { spawn } from 'node:child_process';
import rawFs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { killProcessTree } from '../node-shell-config-io.js';

/** Default per-stream output retention cap in UTF-16 code units (400k chars each for stdout & stderr). */
export const DEFAULT_CONTROLLED_OUTPUT_CAP = 400_000;

export interface ControlledProcessOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** Maximum retained characters per stream (stdout and stderr independently, keeping the tail). Defaults to 400_000. */
  maxOutputChars?: number;
}

export interface ControlledProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface ResolveNpmCommandIo {
  platform?: NodeJS.Platform;
  execPath?: string;
  existsSync?: (candidatePath: string) => boolean;
}

/**
 * Resolve `npm` invocation without shell interpolation: on Windows, Node prohibits direct `spawn`
 * of `.cmd` with `shell: false`, so locate `node_modules/npm/bin/npm-cli.js` beside `process.execPath`.
 */
export function resolveNpmCommand(io: ResolveNpmCommandIo = {}): { command: string; args: string[] } {
  const platform = io.platform ?? process.platform;
  if (platform !== 'win32') return { command: 'npm', args: [] };
  const execPath = io.execPath ?? process.execPath;
  const existsSync = io.existsSync ?? rawFs.existsSync;
  const pathMod = path.win32;
  const execDir = pathMod.dirname(execPath);
  const candidates = [
    pathMod.join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    pathMod.join(execDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const cliJs of candidates) {
    if (existsSync(cliJs)) return { command: execPath, args: [cliJs] };
  }
  throw new Error(
    `unable to locate npm entrypoint npm-cli.js (tried: ${candidates.join(' ; ')}); cannot spawn npm.cmd directly without a shell`,
  );
}

/** Append `chunk` to `current` keeping at most the trailing `cap` characters. */
function appendTailCapped(
  current: string,
  chunk: string,
  cap: number,
  alreadyTruncated: boolean,
): { value: string; truncated: boolean } {
  if (cap <= 0) {
    return { value: '', truncated: alreadyTruncated || chunk.length > 0 };
  }
  if (chunk.length >= cap) {
    return {
      value: chunk.slice(chunk.length - cap),
      truncated: alreadyTruncated || current.length > 0 || chunk.length > cap,
    };
  }
  const combined = current + chunk;
  if (combined.length > cap) {
    return { value: combined.slice(combined.length - cap), truncated: true };
  }
  return { value: combined, truncated: alreadyTruncated };
}

/**
 * Spawn a subprocess without a shell, capture tail-capped UTF-8 stdout/stderr, and kill the entire
 * process tree on timeout. Spawn failures reject; normal exit and timeout resolve with structured state.
 */
export function runControlledProcess(
  command: string,
  args: readonly string[],
  options: ControlledProcessOptions,
): Promise<ControlledProcessResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return Promise.reject(new Error(`controlled process timeoutMs must be a positive finite number (got ${options.timeoutMs})`));
  }
  const cap = options.maxOutputChars ?? DEFAULT_CONTROLLED_OUTPUT_CAP;
  if (!Number.isFinite(cap) || cap < 0) {
    return Promise.reject(new Error(`controlled process maxOutputChars must be a non-negative finite number (got ${cap})`));
  }

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        ...(options.env !== undefined ? { env: options.env } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      const next = appendTailCapped(stdout, chunk, cap, stdoutTruncated);
      stdout = next.value;
      stdoutTruncated = next.truncated;
    });
    child.stderr?.on('data', (chunk: string) => {
      const next = appendTailCapped(stderr, chunk, cap, stderrTruncated);
      stderr = next.value;
      stderrTruncated = next.truncated;
    });

    const settle = (result: ControlledProcessResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      if (child.pid !== undefined) killProcessTree(child.pid);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      settle({
        code: -1,
        stdout,
        stderr,
        timedOut: true,
        stdoutTruncated,
        stderrTruncated,
      });
    }, options.timeoutMs);

    child.on('error', (error) => settle(error));
    child.on('close', (code) => {
      settle({
        code: code ?? -1,
        stdout,
        stderr,
        timedOut: false,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}
