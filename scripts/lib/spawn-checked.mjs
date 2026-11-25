/**
 * Managed child-process executor: the single process channel through which check-changed runs
 * typecheck / test commands sequentially.
 *
 * Why not bare spawn + child.kill: this repo's test discipline requires "no script process
 * ever leaves orphans". It shares the mechanism of scripts/run-tests.mjs to guarantee the
 * whole process tree can be terminated, but with stricter semantics:
 *   - leader exit ≠ whole group stopped: on POSIX the liveness of the owned process group
 *     (detached PGID) is polled continuously; while any member remains (e.g. a grandchild
 *     ignoring SIGTERM) it never settles early;
 *   - the child may itself be a supervisor (e.g. run-tests.mjs creates its own detached child
 *     group G2 and drains G2 before exiting after a signal): the outer layer only supervises
 *     its own owned group G1, which stays non-empty until the child finishes draining G2
 *     (leader exit does not settle); the outer layer grants a generous self-cleanup window
 *     (default 25s, covering the child's internal 5s grace + 15s last-resort) before
 *     escalating to SIGKILL on G1; if it is still non-empty, a bounded last-resort applies:
 *     final SIGKILL + unref, then settle by signal code (never just resolve while keeping a
 *     live child handle pinning the process);
 *   - Windows: no process-group signals; taskkill /PID <pid> /T /F kills the whole tree of
 *     the owned ChildProcess, waits for taskkill to finish and honestly reports its exit code
 *     and output (failure diagnostics are never swallowed);
 *   - repeated SIGINT/SIGTERM are idempotent: only one round of timers is ever created.
 * Exit codes pass through honestly: a child exiting by code returns it verbatim; termination
 * by signal settles as 128+signal (the GNU timeout convention).
 *
 * Package-manager invoke resolution (resolvePackageManagerInvoke): on Windows spawn('pnpm')
 * is unusable with shell:false due to .cmd resolution (EINVAL); prefer constructing argv from
 * the npm_execpath injected by pnpm and never concatenate shell strings: .js/.cjs/.mjs entries
 * run under the current Node after suffix validation; pnpm.exe (the executable launcher
 * injected by the official standalone install) is a real executable and is spawned directly;
 * everything else falls back.
 */
import { spawn } from 'node:child_process';

/** Default termination timeline (milliseconds); tests may inject shorter values via the timings parameter. */
export const DEFAULT_KILL_TIMINGS = {
  pollMs: 100, // poll interval for owned-group liveness
  cleanupGraceMs: 25_000, // window for the child supervisor to self-clean (run-tests: 5s grace + 15s last-resort) before SIGKILL escalation
  lastResortMs: 45_000, // overall fallback: settle forcibly when due; never wait forever
};

/**
 * @typedef {{ cmd: string, args: string[], label: string }} ManagedCommand
 * @typedef {{ pollMs?: number, cleanupGraceMs?: number, lastResortMs?: number }} KillTimings
 */

/**
 * Resolve the package-manager invoke argv usable in this repo (cross-platform, no shell involved).
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ cmd: string, args: string[] }}
 */
export function resolvePackageManagerInvoke(env = process.env) {
  const execPath = env.npm_execpath;
  // A pnpm run child process always carries npm_execpath pointing at the package-manager JS
  // entry; run it under the current Node after suffix validation, avoiding the Windows .cmd
  // resolution problem and the shell-string injection surface. Abnormal values fall back to
  // pnpm on PATH (POSIX shebangs spawn directly; for direct node invocations of scripts on
  // Windows, enter through a pnpm script).
  if (typeof execPath === 'string' && /\.(cjs|mjs|js)$/.test(execPath)) {
    return { cmd: process.execPath, args: [execPath] };
  }
  // The npm_execpath injected by the official pnpm standalone install (common on Windows)
  // points at the pnpm.exe executable launcher: an .exe is a real executable, not a .cmd
  // script — no shell, no injection surface, the same trust level as the .cjs branch, so
  // spawn it directly; falling back to bare 'pnpm' would resolve to pnpm.cmd on Windows and
  // hit EINVAL. basename splits on both separators: POSIX path.basename does not recognize
  // backslashes and cannot parse Windows paths.
  if (typeof execPath === 'string' && execPath.split(/[\\/]/).pop()?.toLowerCase() === 'pnpm.exe') {
    return { cmd: execPath, args: [] };
  }
  return { cmd: 'pnpm', args: [] };
}

/**
 * Run a single command and return detailed exit + optional captured output.
 * @param {ManagedCommand} command
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timings?: KillTimings, capture?: boolean, signal?: AbortSignal, handleSignals?: boolean }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string, output: string }>}
 */
export function runManagedCommandDetailed(command, opts = {}) {
  const {
    cwd = process.cwd(),
    env,
    timings,
    capture = false,
    signal,
    handleSignals = true,
  } = opts;
  const t = { ...DEFAULT_KILL_TIMINGS, ...timings };
  if (signal?.aborted) {
    return Promise.resolve({ code: 143, stdout: '', stderr: '', output: '' });
  }
  return new Promise((resolve) => {
    const child = spawn(command.cmd, command.args, {
      cwd,
      env: env ?? process.env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      detached: process.platform !== 'win32', // POSIX standalone process group so kill(-pid) takes down the whole group
    });
    const label = command.label;
    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    /** @type {Buffer[]} */
    const combinedChunks = [];
    if (capture) {
      child.stdout?.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutChunks.push(buf);
        combinedChunks.push(buf);
      });
      child.stderr?.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrChunks.push(buf);
        combinedChunks.push(buf);
      });
    }

    let terminating = false; // an external signal arrived; termination in progress
    let forcedExitCode = null;
    let finished = false;
    /** @type {Set<ReturnType<typeof setTimeout>>} */
    const timers = new Set();
    let pollTimer = null;

    const later = (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timers.add(timer);
      return timer;
    };
    const clearAllTimers = () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    /** Whether the owned group still has live members: leader exit does not mean the whole group stopped (grandchildren may ignore signals). */
    const groupAlive = () => {
      if (process.platform === 'win32') {
        return child.exitCode === null && child.signalCode === null;
      }
      if (child.pid == null) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (err) {
        return err?.code !== 'ESRCH'; // EPERM and similar are still conservatively treated as "alive"
      }
    };

    const killGroup = (sig) => {
      if (process.platform === 'win32' || child.pid == null) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        // The group is already gone; nothing to do.
      }
    };

    /** Windows: taskkill the whole tree, await completion, and honestly report failure diagnostics. */
    const windowsKillTree = () =>
      new Promise((res) => {
        if (child.pid == null) {
          res();
          return;
        }
        const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        tk.stdout?.on('data', (d) => {
          out += String(d);
        });
        tk.stderr?.on('data', (d) => {
          out += String(d);
        });
        tk.on('error', (err) => {
          console.error(`[${label}] taskkill failed to start: ${err.message}`);
          res();
        });
        tk.on('exit', (code) => {
          if (code !== 0) {
            console.error(`[${label}] taskkill exit code ${code}: ${out.trim() || '(no output)'}`);
          }
          res();
        });
      });

    /** Poll the owned group until drained; settle only when the group fully disappears (POSIX); Windows settles on child exit. */
    const startGroupWatch = () => {
      if (pollTimer || finished) return;
      pollTimer = setInterval(() => {
        if (!groupAlive()) finish(forcedExitCode);
      }, t.pollMs);
    };

    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearAllTimers();
      if (handleSignals) {
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigterm);
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      // In the last-resort fallback the child may still be alive: unref so a live handle
      // cannot pin the host process (the owned group already took SIGKILL; leftovers are
      // reaped by the OS).
      if (child.exitCode === null && child.signalCode === null) child.unref();
      resolve({
        code,
        stdout: capture ? Buffer.concat(stdoutChunks).toString('utf8') : '',
        stderr: capture ? Buffer.concat(stderrChunks).toString('utf8') : '',
        output: capture ? Buffer.concat(combinedChunks).toString('utf8') : '',
      });
    };

    /** External signal (Ctrl+C / SIGTERM / AbortSignal): forward to the owned group, wait for self-cleanup and drain; idempotent. */
    const terminateTree = (sig, { log = true } = {}) => {
      if (finished || terminating) return;
      terminating = true;
      forcedExitCode = sig === 'SIGINT' ? 130 : 143;
      if (log) {
        console.error(`[${label}] received ${sig}, terminating the child process tree (pid ${child.pid}) and waiting for its own cleanup to finish`);
      }
      if (child.pid == null) {
        finish(forcedExitCode);
        return;
      }
      if (process.platform === 'win32') {
        windowsKillTree().then(() => {
          if (!finished) startGroupWatch();
        });
      } else {
        killGroup(sig);
        // Grant the supervisor child a generous self-cleanup window first (it may still need
        // to kill its own detached child group); escalate to SIGKILL only if it is still
        // alive past the window — never treat leader exit as the whole group stopping.
        later(() => killGroup('SIGKILL'), t.cleanupGraceMs);
        startGroupWatch();
      }
      later(() => {
        console.error(`[${label}] owned group not drained within ${t.lastResortMs}ms after termination; forcing last-resort settlement.`);
        killGroup('SIGKILL');
        finish(forcedExitCode);
      }, t.lastResortMs);
    };

    const onSigint = () => terminateTree('SIGINT');
    const onSigterm = () => terminateTree('SIGTERM');
    const onAbort = () => terminateTree('SIGTERM', { log: false });
    if (handleSignals) {
      process.on('SIGINT', onSigint);
      process.on('SIGTERM', onSigterm);
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      if (finished) return;
      console.error(`[${label}] failed to start: ${err.message}`);
      finish(127);
    });

    child.on('exit', (code, sig) => {
      if (finished) return;
      if (terminating) return; // the termination path is settled by the group-liveness poll; leader exit settles nothing and clears no timers
      if (code !== null) {
        finish(code);
        return;
      }
      const signalExit = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 }[sig] ?? 1;
      finish(signalExit);
    });
  });
}

/**
 * Run a single command and return its real exit code (0 means success).
 * @param {ManagedCommand} command
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timings?: KillTimings, signal?: AbortSignal, handleSignals?: boolean }} [opts]
 * @returns {Promise<number>}
 */
export async function runManagedCommand(command, opts = {}) {
  const res = await runManagedCommandDetailed(command, opts);
  return res.code;
}

/**
 * Run the command list sequentially: stop at the first failure and return its exit code verbatim; return 0 when all pass.
 * @param {ManagedCommand[]} commands
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, timings?: KillTimings }} opts
 * @returns {Promise<number>}
 */
export async function runSequentially(commands, opts) {
  for (const cmd of commands) {
    console.error(`\n[check-changed] ▶ ${cmd.label}`);
    const code = await runManagedCommand(cmd, opts);
    if (code !== 0) {
      console.error(`[check-changed] ✗ ${cmd.label} failed with exit code ${code} (remaining commands skipped)`);
      return code;
    }
    console.error(`[check-changed] ✓ ${cmd.label} passed`);
  }
  return 0;
}
