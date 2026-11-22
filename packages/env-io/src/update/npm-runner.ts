/**
 * Controlled npm process runner: delegates to `resolveNpmCommand` + `runControlledProcess`
 * (shell-free spawn, tail-capped captured output, and full process-tree kill on timeout).
 */
import { DEFAULT_CONTROLLED_OUTPUT_CAP, resolveNpmCommand, runControlledProcess } from './process-runner.js';

const NPM_OUTPUT_DIAG_LINES = 40;

function lastLines(text: string, count: number): string {
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/).filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''));
  return lines.slice(-count).join('\n');
}

/** Run npm with a hard timeout, killing the entire process group via `killProcessTree` on expiry. */
export async function runNpm(args: string[], cwd: string, timeoutMs: number): Promise<void> {
  const npm = resolveNpmCommand();
  const fullArgs = [...npm.args, ...args];
  const displayCmd = `npm ${args[0]}`;
  let result;
  try {
    result = await runControlledProcess(npm.command, fullArgs, {
      cwd,
      timeoutMs,
      maxOutputChars: DEFAULT_CONTROLLED_OUTPUT_CAP,
    });
  } catch (error) {
    throw new Error(`${displayCmd} failed to start: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.timedOut) {
    throw new Error(
      `${displayCmd} timed out (${timeoutMs}ms) and was terminated; last ${NPM_OUTPUT_DIAG_LINES} lines:\n${lastLines(`${result.stdout}\n${result.stderr}`, NPM_OUTPUT_DIAG_LINES)}`,
    );
  }
  if (result.code !== 0) {
    throw new Error(
      `${displayCmd} failed with exit code ${result.code}; last ${NPM_OUTPUT_DIAG_LINES} lines:\n${lastLines(`${result.stdout}\n${result.stderr}`, NPM_OUTPUT_DIAG_LINES)}`,
    );
  }
}
