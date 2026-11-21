/**
 * Lightweight Node 24 custom test reporter that emits exact per-file durations (ms) as JSON.
 *
 * Used alongside the built-in `spec` reporter for `isolated` shards via Node's multi-reporter
 * flags (`--test-reporter=spec --test-reporter-destination=stdout --test-reporter=<this>
 * --test-reporter-destination=<tmpfile>`), keeping stdout human-readable while automatically
 * feeding real per-file timings into the LPT timing cache.
 */
export default async function* timingReporter(source) {
  /** @type {Map<string, number>} */
  const summaryMs = new Map();
  /** @type {Map<string, number>} */
  const topLevelMs = new Map();
  /** @type {Map<string, number>} */
  const startWall = new Map();
  /** @type {Map<string, number>} */
  const wallSpanMs = new Map();

  for await (const ev of source) {
    const data = ev.data;
    if (!data) continue;

    if (ev.type === 'test:summary' && typeof data.file === 'string' && typeof data.duration_ms === 'number') {
      summaryMs.set(data.file, Math.max(1, Math.round(data.duration_ms)));
      continue;
    }

    if (typeof data.file !== 'string') continue;

    if (ev.type === 'test:start') {
      if (!startWall.has(data.file)) {
        startWall.set(data.file, performance.now());
      }
    } else if (ev.type === 'test:pass' || ev.type === 'test:fail') {
      const started = startWall.get(data.file);
      if (started !== undefined) {
        wallSpanMs.set(data.file, Math.max(1, Math.round(performance.now() - started)));
      }
      if (data.nesting === 0 && typeof data.details?.duration_ms === 'number') {
        topLevelMs.set(data.file, (topLevelMs.get(data.file) ?? 0) + data.details.duration_ms);
      }
    }
  }

  /** @type {Record<string, number>} */
  const files = {};
  const allFiles = new Set([...summaryMs.keys(), ...topLevelMs.keys(), ...wallSpanMs.keys()]);
  for (const file of allFiles) {
    const dur = summaryMs.get(file) ?? wallSpanMs.get(file) ?? Math.round(topLevelMs.get(file) ?? 1);
    files[file] = Math.max(1, Math.round(dur));
  }

  yield `${JSON.stringify({ files })}\n`;
}
