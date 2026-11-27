import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { deferred, sleep } from '@helmx/test-kit';
import { useTempDir } from '@helmx/test-kit/node';
import {
  isProcessAlive,
  parseLinuxStartTime,
  readLogFrom,
  readLogTailBounded,
  readProcessStartTime,
  waitForPidExit,
  withCrossProcessFileLock,
} from '../src/process-utils.js';

test('parseLinuxStartTime parses raw field-22 ticks even when comm contains spaces and parentheses', { timeout: 60_000 }, () => {
  const fields = Array.from({ length: 25 }, (_, i) => String(100 + i));
  fields[19] = '987654321';
  const stat = `12345 (my (weird) proc) ${fields.join(' ')}\n`;
  assert.equal(parseLinuxStartTime(stat), 987654321);
  assert.equal(parseLinuxStartTime('malformed'), null);
  assert.equal(parseLinuxStartTime('123 (ok) S 1 2 3'), null);
});

test('isProcessAlive / waitForPidExit / readProcessStartTime work on current process', { timeout: 60_000 }, async () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(-1), false);
  let checks = 0;
  const exited = await waitForPidExit(
    999999,
    500,
    () => {
      checks += 1;
      return checks < 3;
    },
    10,
  );
  assert.equal(exited, true);
  assert.ok(checks >= 3);

  const timedOut = await waitForPidExit(999999, 30, () => true, 10);
  assert.equal(timedOut, false);

  const start = await readProcessStartTime(process.pid);
  if (process.platform === 'linux') {
    assert.ok(typeof start === 'number' && Number.isInteger(start) && start >= 0);
  } else {
    assert.equal(start, null);
  }
});

test('readLogTailBounded caps bytes and preserves UTF-8 across mid-file boundaries', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-env-io-logtail-');
  const file = path.join(dir, 'app.log');
  const prefix = '前缀'.repeat(500);
  const lines = [prefix, 'line-a 你好', 'line-b 世界', 'line-c 结束'];
  await fsp.writeFile(file, `${lines.join('\n')}\n`, 'utf8');

  const tail = await readLogTailBounded(file, 2, 128);
  assert.equal(tail, 'line-b 世界\nline-c 结束');
  assert.ok(!tail.includes('\uFFFD'), 'bounded tail must never produce UTF-8 replacement chars');
  assert.equal(await readLogTailBounded(path.join(dir, 'missing.log'), 10), '');
});

test('readLogFrom reads incrementally by byte offset without splitting multi-byte UTF-8 chars', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-env-io-logfrom-');
  const file = path.join(dir, 'stream.log');
  const payload = '你好世界Helmx🎉end\n';
  await fsp.writeFile(file, payload, 'utf8');

  let offset = 0;
  let collected = '';
  for (let i = 0; i < 20; i += 1) {
    // 5-byte chunks intentionally cut across 3-byte and 4-byte UTF-8 sequences.
    const chunk = await readLogFrom(file, offset, 5);
    if (chunk.text === '' && chunk.offset === offset) break;
    assert.ok(!chunk.text.includes('\uFFFD'), `chunk ${i} must be valid UTF-8: ${JSON.stringify(chunk.text)}`);
    collected += chunk.text;
    offset = chunk.offset;
  }
  assert.equal(collected, payload);
});

test('withCrossProcessFileLock recovers dead-PID stale locks, rejects live holders, and preserves corrupt locks', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-env-io-lock-');
  const lockPath = path.join(dir, 'resource.lock');

  // 1. Confirmed-dead PID stale lock is recovered automatically.
  await fsp.writeFile(lockPath, '424242 stale-uuid\n', 'utf8');
  const ran = await withCrossProcessFileLock(
    lockPath,
    async () => {
      const content = await fsp.readFile(lockPath, 'utf8');
      assert.ok(content.startsWith(`${process.pid} `));
      return 'ok';
    },
    { waitMs: 0, isAlive: () => false },
  );
  assert.equal(ran, 'ok');
  assert.equal(await fsp.stat(lockPath).then(() => true, () => false), false, 'lock removed after completion');

  // 2. Live holder PID is never broken and invokes onBusy.
  await fsp.writeFile(lockPath, `${process.pid} live-uuid\n`, 'utf8');
  await assert.rejects(
    withCrossProcessFileLock(lockPath, async () => 'never', {
      waitMs: 0,
      isAlive: () => true,
      onBusy: (p, pid) => new Error(`busy:${pid}:${path.basename(p)}`),
    }),
    new RegExp(`busy:${process.pid}:resource\\.lock`),
  );
  assert.equal(await fsp.stat(lockPath).then(() => true, () => false), true, 'live lock preserved');
  await fsp.rm(lockPath, { force: true });

  // 3. Empty/corrupt lock is preserved and invokes onCorrupt (never silently deleted).
  await fsp.writeFile(lockPath, '', 'utf8');
  await assert.rejects(
    withCrossProcessFileLock(lockPath, async () => 'never', {
      waitMs: 0,
      onCorrupt: (p) => new Error(`corrupt:${path.basename(p)}`),
    }),
    /corrupt:resource\.lock/,
  );
  assert.equal(await fsp.stat(lockPath).then(() => true, () => false), true, 'empty/corrupt lock preserved');
});

test('readLogTailBounded and readLogFrom rethrow EISDIR instead of masking directory read errors as empty', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-env-io-logdir-');
  const subDir = path.join(dir, 'dir-as-log');
  await fsp.mkdir(subDir, { recursive: true });
  await assert.rejects(
    readLogTailBounded(subDir, 10),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'EISDIR',
  );
  await assert.rejects(
    readLogFrom(subDir, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'EISDIR',
  );
  assert.deepEqual(await readLogFrom(path.join(dir, 'missing.log'), 0), { text: '', offset: 0 });
});

test('withCrossProcessFileLock stale-lock recovery preserves mutual exclusion under concurrent races', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-env-io-lock-race-');
  const lockPath = path.join(dir, 'race.lock');
  await fsp.writeFile(lockPath, '424242 dead-owner\n', 'utf8');

  let active = 0;
  let maxActive = 0;
  let completed = 0;
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, idx) =>
      withCrossProcessFileLock(
        lockPath,
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 15));
          active -= 1;
          completed += 1;
          return idx;
        },
        {
          waitMs: 10_000,
          pollMs: 5,
          isAlive: (pid) => pid === process.pid,
        },
      ),
    ),
  );
  assert.equal(results.length, 10);
  assert.equal(completed, 10);
  assert.equal(maxActive, 1, 'concurrent stale-lock breakers must never enter critical section simultaneously');
  assert.equal(await fsp.stat(lockPath).then(() => true, () => false), false, 'lock removed cleanly after all waiters finish');
});

test('withCrossProcessFileLock holder displaced by a stalled stale breaker waits it out, never enters, and re-acquires', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-env-io-lock-stalled-breaker-');
  const lockPath = path.join(dir, 'stalled.lock');
  const deadOwner = '424242 dead-owner\n';
  await fsp.writeFile(lockPath, deadOwner, 'utf8');

  const breakerConfirmedDead = deferred();
  const releaseBreaker = deferred();
  const holderSawLiveMarker = deferred();
  const entered = { breaker: 0, holder: 0 };
  let active = 0;
  let maxActive = 0;
  const criticalSection = async (who: 'breaker' | 'holder'): Promise<void> => {
    entered[who] += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(15);
    active -= 1;
  };

  // Breaker: confirms the dead owner under its break marker, then stalls before the removal.
  const breaker = withCrossProcessFileLock(lockPath, () => criticalSection('breaker'), {
    waitMs: 5_000,
    pollMs: 5,
    isAlive: (pid) => pid !== 424242,
    beforeStaleRemoval: async () => {
      breakerConfirmedDead.resolve();
      await releaseBreaker.promise;
    },
  });
  t.after(() => releaseBreaker.resolve(), { timeout: 60_000 });
  await breakerConfirmedDead.promise;
  assert.equal(await fsp.readFile(lockPath, 'utf8'), deadOwner, 'dead lock stays untouched while the breaker is stalled');
  const markers = (await fsp.readdir(dir)).filter((name) => name.endsWith('.stale'));
  assert.equal(markers.length, 1, 'breaker holds its break marker before touching the lock');
  assert.deepEqual(entered, { breaker: 0, holder: 0 });

  // Another breaker already cleared the dead file; a fresh holder publishes behind the stalled one.
  await fsp.rm(lockPath);
  const holder = withCrossProcessFileLock(lockPath, () => criticalSection('holder'), {
    waitMs: 5_000,
    pollMs: 5,
    // Only the break-marker liveness scan can call this: the lock path was empty when the holder published.
    isAlive: (pid) => {
      holderSawLiveMarker.resolve();
      return pid === process.pid;
    },
  });
  await holderSawLiveMarker.promise;
  assert.deepEqual(entered, { breaker: 0, holder: 0 }, 'holder must not enter while the stalled breaker can still delete its lock');

  releaseBreaker.resolve();
  await Promise.all([breaker, holder]);
  assert.deepEqual(entered, { breaker: 1, holder: 1 }, 'both eventually acquire exactly once (order is not asserted)');
  assert.equal(maxActive, 1, 'stalled breaker and displaced holder never overlap in the critical section');
  assert.equal(await fsp.stat(lockPath).then(() => true, () => false), false, 'lock removed after completion');
  assert.deepEqual((await fsp.readdir(dir)).filter((name) => name.includes('stalled.lock')), [], 'no lock, marker or temp leftovers');
});

test('withCrossProcessFileLock ignores dead-PID break markers forever and bounds waiting on live ones by settleGraceMs when waitMs is 0', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-env-io-lock-markers-');
  const lockPath = path.join(dir, 'markers.lock');
  const deadMarker = `${lockPath}.424242.dead-uuid.stale`;
  const liveMarker = `${lockPath}.${process.pid}.live-uuid.stale`;
  const isAlive = (pid: number): boolean => pid === process.pid;

  // 1. A marker left by a crashed breaker is neither a blocker nor garbage: its owner cannot act anymore.
  await fsp.writeFile(deadMarker, '424242 gone\n', 'utf8');
  const ran = await withCrossProcessFileLock(lockPath, async () => 'ok', { waitMs: 0, pollMs: 5, settleGraceMs: 80, isAlive });
  assert.equal(ran, 'ok', 'a dead-PID marker must not consume the settle window');
  assert.equal(await fsp.readFile(deadMarker, 'utf8'), '424242 gone\n', 'dead-PID marker is preserved, never deleted');
  await fsp.rm(deadMarker);

  // 2. A live marker blocks entry for at most settleGraceMs (there is no wait budget when waitMs is 0),
  //    then fails explicitly, releases our own lock, and leaves the foreign marker alone.
  await fsp.writeFile(liveMarker, `${process.pid} busy\n`, 'utf8');
  const startedAt = Date.now();
  await assert.rejects(
    withCrossProcessFileLock(lockPath, async () => 'never', { waitMs: 0, pollMs: 5, settleGraceMs: 80, isAlive }),
    (error: unknown) => {
      assert.ok(error instanceof Error, 'busy verdict must be an Error');
      assert.match(error.message, /stale-lock recovery is in progress \(/);
      assert.ok(error.message.includes(path.basename(liveMarker)), `verdict names the blocking marker: ${error.message}`);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt >= 70, 'must wait out the settle window before declaring stale recovery stuck');
  assert.equal(await fsp.stat(lockPath).then(() => true, () => false), false, 'own lock is released when acquisition fails');
  assert.equal(await fsp.readFile(liveMarker, 'utf8'), `${process.pid} busy\n`, 'foreign live marker is never deleted');
});

test('withCrossProcessFileLock waits out the settle window for a fresh unowned lock before surfacing it as corrupt', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-env-io-lock-settle-');
  const lockPath = path.join(dir, 'settle.lock');

  // 1. A freshly written empty lock inside the grace window is polled, not declared corrupt at once.
  await fsp.writeFile(lockPath, '', 'utf8');
  const startedAt = Date.now();
  await assert.rejects(
    withCrossProcessFileLock(lockPath, async () => 'never', {
      waitMs: 5_000,
      pollMs: 5,
      settleGraceMs: 80,
      isAlive: () => true,
      onCorrupt: (p) => new Error(`corrupt:${path.basename(p)}`),
    }),
    /corrupt:settle\.lock/,
  );
  assert.ok(Date.now() - startedAt >= 70, 'corrupt verdict must wait for the settle window to elapse');
  assert.equal(await fsp.readFile(lockPath, 'utf8'), '', 'unowned lock is preserved, never deleted');

  // 2. An unowned lock that disappears during the window lets the waiter in.
  const removal = setTimeout(() => {
    void fsp.rm(lockPath, { force: true });
  }, 40);
  t.after(() => clearTimeout(removal), { timeout: 60_000 });
  const ran = await withCrossProcessFileLock(lockPath, async () => 'acquired', {
    waitMs: 5_000,
    pollMs: 5,
    settleGraceMs: 5_000,
    isAlive: () => true,
  });
  assert.equal(ran, 'acquired');
  assert.equal(await fsp.stat(lockPath).then(() => true, () => false), false, 'lock removed after completion');
});

test('withCrossProcessFileLock falls back to an exclusive wx create when the filesystem rejects hard links', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-env-io-lock-wx-');
  const lockPath = path.join(dir, 'wx.lock');
  const realLink = fsp.link;
  fsp.link = (async () => {
    throw Object.assign(new Error('hard links unsupported on this filesystem'), { code: 'EXDEV' });
  }) as typeof fsp.link;
  t.after(() => {
    fsp.link = realLink;
  }, { timeout: 60_000 });

  const ran = await withCrossProcessFileLock(
    lockPath,
    async () => {
      const content = await fsp.readFile(lockPath, 'utf8');
      assert.ok(content.startsWith(`${process.pid} `), 'fallback write must carry the owner token');
      return 'ok';
    },
    { waitMs: 0 },
  );
  assert.equal(ran, 'ok');
  assert.equal(await fsp.stat(lockPath).then(() => true, () => false), false, 'lock removed after completion');
  assert.deepEqual((await fsp.readdir(dir)).filter((name) => name.includes('wx.lock')), [], 'no temp or stale leftovers');
});
