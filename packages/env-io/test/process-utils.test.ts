import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
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
