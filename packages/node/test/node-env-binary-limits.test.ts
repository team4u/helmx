/**
 * Regression tests for the 64 MiB binary transfer limit and exact boundary writes.
 *
 * `envReadBinaryFile` / `envBinaryReaderRead` / `envWriteFile` (before and after base64
 * decoding) explicitly fail with `invalid` when payloads exceed the limit, never truncating
 * silently or letting the node daemon buffer oversized base64 frames; valid 64 MiB writes succeed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { useTempDir } from '@helmx/test-kit/node';

import { createNodeEnvRpcServer } from '../src/daemon/env-rpc-server.js';

const LIMIT = 64 * 1024 * 1024;

test('envBinaryReaderRead rejects oversized length with invalid without materializing bytes', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'b64-limit-reader-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(() => server.dispose());
  await fs.writeFile(path.join(dir, 'small.bin'), Buffer.from([1, 2, 3]));
  const opened = await server.envOpenBinaryReader({ path: 'small.bin' });
  assert.equal(opened.ok, true);
  const readerId = opened.ok ? opened.value.readerId : '';

  // Reject length exceeding limit without performing any read.
  const tooBig = await server.envBinaryReaderRead({ readerId, offset: 0, length: LIMIT + 1 });
  assert.equal(tooBig.ok, false);
  assert.equal(!tooBig.ok && tooBig.error.code, 'invalid');
  assert.match(!tooBig.ok && tooBig.error.message, /no greater than/);

  // Boundary request equal to limit is valid (callers paginate large files in chunks).
  const edge = await server.envBinaryReaderRead({ readerId, offset: 0, length: LIMIT });
  assert.equal(edge.ok, true, 'request right at the limit is valid (file here is only 3 bytes)');

  // Non-integer length is still rejected by underlying validation.
  const badShape = await server.envBinaryReaderRead({ readerId, offset: 0, length: Number.NaN });
  assert.equal(badShape.ok, false);
});

test('envWriteFile rejects oversized base64 payload before decoding', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'b64-limit-write-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(() => server.dispose());

  // Encoded limit accounts for 4/3 base64 expansion; oversized input is rejected prior to decoding.
  const huge = 'A'.repeat(Math.ceil(LIMIT / 3) * 4 + 4);
  const rejected = await server.envWriteFile({ path: 'big.bin', content: huge, encoding: 'base64' });
  assert.equal(rejected.ok, false);
  assert.equal(!rejected.ok && rejected.error.code, 'invalid');
  assert.match(!rejected.ok && rejected.error.message, /exceeds/);
  assert.equal(
    await fs.stat(path.join(dir, 'big.bin')).then(() => true, () => false),
    false,
    'oversized write must not hit disk',
  );
});

test('envWriteFile rejects writes whose decoded UTF-8 byte count exceeds the limit', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'b64-limit-decode-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(() => server.dispose());

  // Character count is below the limit, while encoded UTF-8 bytes exceed it; both write and append must reject.
  const bigUtf8 = '中'.repeat(Math.floor(LIMIT / 3) + 1);
  const rejected = await server.envWriteFile({ path: 'big.txt', content: bigUtf8 });
  assert.equal(rejected.ok, false);
  assert.equal(!rejected.ok && rejected.error.code, 'invalid');
  const appendRejected = await server.envAppendFile({ path: 'big.txt', content: bigUtf8 });
  assert.equal(appendRejected.ok, false);
  assert.equal(!appendRejected.ok && appendRejected.error.code, 'invalid');
  assert.equal(await fs.stat(path.join(dir, 'big.txt')).then(() => true, () => false), false);
});

test('envReadBinaryFile explicitly returns invalid when file exceeds limit instead of truncating', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'b64-limit-read-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(() => server.dispose());

  // Create a sparse logical 64MiB + 1 file via truncate.
  await fs.writeFile(path.join(dir, 'huge.bin'), Buffer.from([0]));
  await fs.truncate(path.join(dir, 'huge.bin'), LIMIT + 1);
  const result = await server.envReadBinaryFile({ path: 'huge.bin' });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'invalid');
  assert.match(!result.ok && result.error.message, /transfer limit/);
});

test('valid 64MiB base64 write succeeds without padding deducting from byte quota', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-base64-boundary-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(() => server.dispose());
  const encodedLength = Math.ceil(LIMIT / 3) * 4;
  // Standard base64 for all-zero 64MiB has two trailing padding chars whose decoded bytes are excluded.
  const result = await server.envWriteFile({
    path: 'edge.bin',
    content: 'A'.repeat(encodedLength - 2) + '==',
    encoding: 'base64',
  });
  assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
  assert.equal((await fs.stat(path.join(dir, 'edge.bin'))).size, LIMIT);
});

test('envReadTextFile enforces 64MiB cap, and readers enforce maxOpenReaders and readerIdleTtlMs', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-text-and-readers-bounds-');
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    maxCachedEnvs: 2,
    maxOpenReaders: 2,
    readerIdleTtlMs: 30,
  });
  t.after(() => server.dispose());

  // Sparse 64MiB + 1 text file is rejected before reading into memory.
  await fs.writeFile(path.join(dir, 'huge.txt'), 'x');
  await fs.truncate(path.join(dir, 'huge.txt'), LIMIT + 1);
  const textTooBig = await server.envReadTextFile({ path: 'huge.txt' });
  assert.equal(textTooBig.ok, false);
  assert.equal(!textTooBig.ok && textTooBig.error.code, 'invalid');
  assert.match(!textTooBig.ok && textTooBig.error.message, /transfer limit/);

  // Bounded LRU envs across > maxCachedEnvs cwds keep working seamlessly.
  for (const sub of ['c1', 'c2', 'c3', 'c4']) {
    const subDir = path.join(dir, sub);
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, 'f.txt'), sub);
    const read = await server.envReadTextFile({ path: 'f.txt', cwd: subDir });
    assert.equal(read.ok && read.value, sub);
  }

  // maxOpenReaders rejects once full, then allows opening again after idle TTL sweeps expired readers.
  await fs.writeFile(path.join(dir, 'lines.txt'), 'l1\nl2\n');
  const r1 = await server.envOpenTextLineReader({ path: 'lines.txt' });
  const r2 = await server.envOpenTextLineReader({ path: 'lines.txt' });
  assert.equal(r1.ok && r2.ok, true);
  const r3 = await server.envOpenTextLineReader({ path: 'lines.txt' });
  assert.equal(r3.ok, false, 'exceeding maxOpenReaders must fail');

  await new Promise((resolve) => setTimeout(resolve, 60));
  const r4 = await server.envOpenTextLineReader({ path: 'lines.txt' });
  assert.equal(r4.ok, true, 'idle TTL sweep should reclaim expired readers');
  if (r4.ok) await server.envTextReaderClose({ readerId: r4.value.readerId });
});
