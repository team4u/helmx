/**
 * Persistent shared-process test shard worker for `pure`, `dom-shared`, and `node-shared` pools.
 *
 * Why it exists:
 * - Running each file via sequential `run({ files: [file], isolation: 'none', concurrency: 1 })`
 *   inside one tsx process shares V8 JIT + ESM module graph (React, happy-dom, esbuild, kernel,
 *   plugins, hub) while giving EVERY file its own fresh `node:test` root suite — completely
 *   eliminating cross-file `before()`/`after()`/`beforeEach()`/`afterEach()` hook leaks.
 * - Executes `resetSharedHappyDom()` cleanly between files in `dom-shared` shards.
 * - Feeds per-file events into ONE standard `spec` reporter per shard (exact test counts,
 *   clean failure summary) and writes exact per-file wall durations to `timingOutputPath`.
 * - Emits stderr progress diagnostics (`[shard-worker] boot` / `file i/N <path>`) plus a stall
 *   watchdog that re-warns while no test event arrives, so a hung shard killed by the suite
 *   timeout in `run-tests.mjs` leaves a trail naming the exact file it was running. Without
 *   these lines a silent shard (e.g. stuck during module load before the first `▶` line) is
 *   undiagnosable from the interleaved multi-shard CI log.
 */
import { once } from 'node:events';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

const ROOT_SUMMARY_DIAGNOSTIC_RE = /^(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s/;
/** Default silence window before the stall watchdog warns; manifest `stallWarnMs` overrides (0 disables). */
const DEFAULT_STALL_WARN_MS = 120_000;

function writeJsonAtomic(filePath, data) {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), 'utf8');
    renameSync(tmp, filePath);
  } catch {
    // Timing output is best-effort and must never fail the test run.
  }
}

async function writeEvent(reporter, event) {
  if (!reporter.write(event)) {
    await once(reporter, 'drain');
  }
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error('[shard-worker] usage: shard-worker.mjs <manifest.json>');
    process.exit(2);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const {
    pool = 'pure',
    repoRoot = process.cwd(),
    files = [],
    ipcQueue = false,
    timingOutputPath = null,
    testTimeoutMs = 20_000,
    stallWarnMs = DEFAULT_STALL_WARN_MS,
  } = manifest;

  const useIpcQueue = ipcQueue === true && typeof process.send === 'function';

  // First line the process ever prints: its absence in the log means the hang is before this
  // module even ran (tsx / esbuild boot), not inside a test file.
  console.error(
    `[shard-worker] boot pool=${pool} ${useIpcQueue ? 'mode=ipc' : `files=${files.length}`} pid=${process.pid}`,
  );

  let resetDomFn = null;
  if (pool === 'dom-shared') {
    const mod = await import('./dom-shard-preload.mjs');
    resetDomFn = mod.resetSharedHappyDom;
  }

  // Stall watchdog: armed per file (covering module load too, before any test event exists) and
  // re-armed on each warning so a hung file keeps logging until run-tests.mjs kills the tree.
  let stallTimer = null;
  let stallAnchorMs = 0;
  let stallLabel = '';
  let lastEventType = 'none';
  const touchProgress = (type) => {
    stallAnchorMs = performance.now();
    lastEventType = type;
  };
  const disarmStallWatchdog = () => {
    if (stallTimer) clearInterval(stallTimer);
    stallTimer = null;
  };
  const armStallWatchdog = (label) => {
    if (!(stallWarnMs > 0)) return;
    disarmStallWatchdog();
    stallLabel = label;
    lastEventType = 'none';
    touchProgress('file-start');
    stallTimer = setInterval(() => {
      const idleMs = Math.round(performance.now() - stallAnchorMs);
      // Fixed-cadence tick: events may have kept flowing since it was armed, so only a full
      // silence window counts as a stall (otherwise a healthy >stallWarnMs file is misreported).
      if (idleMs < stallWarnMs) return;
      console.error(
        `[shard-worker] stall: no test event for ${idleMs}ms while running ${stallLabel} ` +
          `(last event: ${lastEventType}); if this repeats until the suite timeout, this file is hung`,
      );
      touchProgress('stall-warning');
    }, stallWarnMs);
    stallTimer.unref?.();
  };

  const totals = {
    tests: 0,
    suites: 0,
    passed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    topLevel: 0,
  };
  /** @type {Record<string, number>} */
  const perFileTimings = {};
  let anyFailed = false;
  let completedFiles = 0;
  let dispatchedFiles = 0;
  const shardStartMs = performance.now();

  const reporter = new spec();
  reporter.pipe(process.stdout, { end: false });

  const pendingIpcMsgs = [];
  let waitingIpcResolve = null;
  const deliverIpcMsg = (msg) => {
    if (waitingIpcResolve) {
      const resolve = waitingIpcResolve;
      waitingIpcResolve = null;
      resolve(msg);
    } else {
      pendingIpcMsgs.push(msg);
    }
  };
  const onIpcMessage = (msg) => deliverIpcMsg(msg);
  const onIpcDisconnect = () => deliverIpcMsg({ type: 'done' });
  if (useIpcQueue) {
    process.on('message', onIpcMessage);
    process.on('disconnect', onIpcDisconnect);
  }
  const receiveIpc = () =>
    pendingIpcMsgs.length > 0
      ? Promise.resolve(pendingIpcMsgs.shift())
      : new Promise((resolve) => {
          waitingIpcResolve = resolve;
        });

  try {
    let staticIdx = 0;
    while (true) {
      let relPath;
      let fileIndex;
      let fileTotal;
      if (useIpcQueue) {
        if (!process.connected) break;
        process.channel?.ref?.();
        process.send({ type: 'next' });
        const job = await receiveIpc();
        process.channel?.unref?.();
        if (!job || job.type === 'done' || typeof job.file !== 'string') break;
        // Leave the IPC I/O poll callback before starting node:test so macrotasks (e.g. setTimeout(0))
        // align with static shard-worker execution order.
        await new Promise((resolve) => setImmediate(resolve));
        relPath = job.file;
        fileIndex = typeof job.index === 'number' ? job.index : dispatchedFiles + 1;
        fileTotal = typeof job.total === 'number' ? job.total : fileIndex;
      } else {
        if (staticIdx >= files.length) break;
        relPath = files[staticIdx];
        fileIndex = staticIdx + 1;
        fileTotal = files.length;
        staticIdx += 1;
      }
      dispatchedFiles += 1;

      const absPath = path.isAbsolute(relPath) ? relPath : path.join(repoRoot, relPath);
      const fileStartMs = performance.now();
      let fileSuccess = true;
      let sawSummary = false;
      const fileLabel = `file ${fileIndex}/${fileTotal} ${relPath.split(path.sep).join('/')}`;
      console.error(`[shard-worker] ${fileLabel}`);
      armStallWatchdog(fileLabel);

      try {
        const stream = run({
          files: [absPath],
          isolation: 'none',
          concurrency: 1,
          timeout: testTimeoutMs,
        });

        for await (const ev of stream) {
          touchProgress(ev.type);
          if (ev.type === 'test:summary') {
            sawSummary = true;
            if (!ev.data?.success) {
              fileSuccess = false;
              anyFailed = true;
            }
            const c = ev.data?.counts;
            if (c) {
              totals.tests += c.tests ?? 0;
              totals.suites += c.suites ?? 0;
              totals.passed += c.passed ?? 0;
              totals.failed += c.failed ?? 0;
              totals.cancelled += c.cancelled ?? 0;
              totals.skipped += c.skipped ?? 0;
              totals.todo += c.todo ?? 0;
              totals.topLevel += c.topLevel ?? 0;
            }
            continue;
          }

          if (
            ev.type === 'test:diagnostic' &&
            ev.data?.nesting === 0 &&
            typeof ev.data?.message === 'string' &&
            ROOT_SUMMARY_DIAGNOSTIC_RE.test(ev.data.message)
          ) {
            // Suppress per-file summary lines; emit one clean aggregated summary at shard end.
            continue;
          }

          if (ev.type === 'test:fail') {
            fileSuccess = false;
            anyFailed = true;
          }
          await writeEvent(reporter, ev);
        }
        if (sawSummary) {
          completedFiles += 1;
        } else {
          fileSuccess = false;
          anyFailed = true;
          console.error(`[shard-worker] missing test:summary for ${relPath}`);
        }
      } catch (err) {
        fileSuccess = false;
        anyFailed = true;
        console.error(`[shard-worker] error running ${relPath}:`, err);
      } finally {
        disarmStallWatchdog();
        const elapsedMs = Math.max(1, Math.round(performance.now() - fileStartMs));
        if (fileSuccess) {
          perFileTimings[relPath.split(path.sep).join('/')] = elapsedMs;
        }
        if (resetDomFn) {
          resetDomFn();
        }
      }

      // Yield one check-phase turn so Node's internal node:test root finishes tearing down
      // before the next sequential `run({ isolation: 'none' })` call starts.
      if (useIpcQueue || staticIdx < files.length) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  } finally {
    if (useIpcQueue) {
      process.off('message', onIpcMessage);
      process.off('disconnect', onIpcDisconnect);
    }
  }

  const expectedFiles = useIpcQueue ? dispatchedFiles : files.length;
  if (completedFiles !== expectedFiles) {
    anyFailed = true;
    console.error(`[shard-worker] invariant violation: completed ${completedFiles}/${expectedFiles} files`);
  }

  const totalDurationMs = performance.now() - shardStartMs;
  const diagnosticLines = [
    `tests ${totals.tests}`,
    `suites ${totals.suites}`,
    `pass ${totals.passed}`,
    `fail ${totals.failed}`,
    `cancelled ${totals.cancelled}`,
    `skipped ${totals.skipped}`,
    `todo ${totals.todo}`,
    `duration_ms ${totalDurationMs}`,
  ];
  for (const message of diagnosticLines) {
    await writeEvent(reporter, { type: 'test:diagnostic', data: { nesting: 0, message } });
  }
  await writeEvent(reporter, {
    type: 'test:summary',
    data: {
      success: !anyFailed,
      counts: totals,
      duration_ms: totalDurationMs,
    },
  });

  reporter.end();
  await finished(reporter);

  if (timingOutputPath) {
    writeJsonAtomic(timingOutputPath, {
      pool,
      files: perFileTimings,
      counts: totals,
      success: !anyFailed,
    });
  }

  if (anyFailed) {
    process.exitCode = 1;
  }
}

await main();
