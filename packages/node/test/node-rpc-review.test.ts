/**
 * Independent review regression tests for `env-rpc-server`: reproduces real edge defects
 * cleanly without duplicating main unit tests (each test documents the specific bug covered).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { exec as execCb } from 'node:child_process';
import { sleep as delay } from '@helmx/test-kit';
import { makeTempDir as tempDir, waitFor as kitWaitFor } from '@helmx/test-kit/node';
import {
  createNodeEnvRpcServer,
} from '../src/daemon/env-rpc-server.js';

/** Poll until observable condition holds (instead of fixed sleeps), failing explicitly on timeout. */
const waitFor = (condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> =>
  kitWaitFor(condition, { timeoutMs, message: `wait timed out: ${what}` });

// ---------------------------------------------------------------------------
// 1. envFlushFile (required protocol primitive): real file / missing / post-dispose
// ---------------------------------------------------------------------------

test('envFlushFile returns ok for real file, not_found when missing, and aborted after dispose', { timeout: 60_000 }, async () => {
  const dir = await tempDir('flush-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  try {
    await fs.writeFile(path.join(dir, 'f.txt'), 'data');
    const ok = await server.envFlushFile({ path: 'f.txt' });
    assert.equal(ok.ok, true);

    // Flushing a directory returns is_directory (checked on Windows too under SDK POSIX semantics)
    await fs.mkdir(path.join(dir, 'd'));
    const isDir = await server.envFlushFile({ path: 'd' });
    assert.equal(isDir.ok, false);
    assert.equal(!isDir.ok && isDir.error.code, 'is_directory');

    // Missing path returns not_found instead of pretending success
    const missing = await server.envFlushFile({ path: 'no-such' });
    assert.equal(missing.ok, false);
    assert.equal(!missing.ok && missing.error.code, 'not_found');
  } finally {
    await server.dispose();
  }

  // Post-dispose wrapper returns structured aborted error envelope without throwing raw errors
  const after = await server.envFlushFile({ path: 'f.txt' });
  assert.equal(after.ok, false);
  assert.equal(!after.ok && after.error.code, 'aborted');
  await fs.rm(dir, { recursive: true, force: true });
});

test('dispose is terminal: file RPCs return structured aborted without recreating env or readers', { timeout: 60_000 }, async () => {
  const dir = await tempDir('dispose-final-');
  await fs.writeFile(path.join(dir, 'a.txt'), 'x');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  const opened = await server.envOpenTextLineReader({ path: 'a.txt' });
  assert.equal(opened.ok, true);
  await server.dispose();
  assert.equal(server.getOpenReaderCount(), 0);

  // Pre-fix bug: envReadTextFile after dispose recreated env and ran (or threw raw error)
  const read = await server.envReadTextFile({ path: 'a.txt' });
  assert.equal(read.ok, false, 'file RPCs after dispose must reject');
  assert.equal(!read.ok && read.error.code, 'aborted');
  const reader = await server.envOpenTextLineReader({ path: 'a.txt' });
  assert.equal(reader.ok, false);
  assert.equal(!reader.ok && reader.error.code, 'aborted');
  await fs.rm(dir, { recursive: true, force: true });
});

test('boundary wrapper turns null inputs and unknown readers into structured errors without throwing', { timeout: 60_000 }, async () => {
  const dir = await tempDir('guard-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  try {
    // Null input previously threw an uncaught TypeError destructuring `{ path }` straight into birpc
    const nullRead = await (server.envReadTextFile as unknown as (input: unknown) => Promise<{ ok: boolean; error?: { code: string } }>)(
      null,
    );
    assert.equal(nullRead.ok, false);
    assert.ok(nullRead.error !== undefined);

    // Unknown readerId returns structured not_found
    const unknown = await server.envTextReaderRead({ readerId: 'r999' });
    assert.equal(unknown.ok, false);
    assert.equal(!unknown.ok && unknown.error.code, 'not_found');
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. envExec strips host HELMX_TOKEN without mutating global process.env (verified via real subprocess)
// ---------------------------------------------------------------------------

test('envExec never leaks host HELMX_TOKEN into children while honoring managed input.env injections', { timeout: 60_000 }, async (t) => {
  // Simulate a daemon host carrying HELMX_TOKEN by swapping process.env (restored via t.after).
  // Upstream NodeExecutionEnv inherits process.env by default, so this proves stripping works
  // genuinely when HELMX_TOKEN is present rather than passing only by deleting global env vars.
  const base = process.env;
  process.env = { ...base, HELMX_TOKEN: 'host-secret-token-do-not-leak' } as NodeJS.ProcessEnv;
  t.after(() => {
    process.env = base;
  });

  const dir = await tempDir('token-iso-');
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    shellEnv: { HELMX_HUB_URL: 'http://hub:3202', HELMX_DATA_DIR: dir },
  });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }, { timeout: 60_000 });

  // 1) Default (inheritEnv omitted): host token must be stripped while base env inherits
  await server.envExec({
    execId: 't1-dump',
    command:
      'node -e \'require("fs").writeFileSync("env-dump.json", JSON.stringify({token:process.env.HELMX_TOKEN??null,hub:process.env.HELMX_HUB_URL??null,hasPath:!!process.env.PATH,hasHome:!!process.env.HOME,data:process.env.HELMX_DATA_DIR??null}))\'',
    timeout: 30,
  });
  const dump1 = JSON.parse(await fs.readFile(path.join(dir, 'env-dump.json'), 'utf8')) as {
    token: string | null;
    hub: string | null;
    hasPath: boolean;
    hasHome: boolean;
    data: string | null;
  };
  assert.equal(dump1.token, null, 'host HELMX_TOKEN must not leak (SDK inheritEnv:true merges process.env by default)');
  assert.equal(dump1.hub, 'http://hub:3202');
  assert.equal(dump1.data, dir);
  assert.equal(dump1.hasPath, true, 'base PATH inherited');
  assert.equal(dump1.hasHome, true, 'base HOME inherited');

  // 2) Explicit input.env HELMX_TOKEN (Hub-managed per-call injection): must pass through
  await server.envExec({
    execId: 't2',
    command: 'node -e \'require("fs").writeFileSync("env-dump2.json", JSON.stringify({token:process.env.HELMX_TOKEN??null}))\'',
    env: { HELMX_TOKEN: 'managed-token-xyz' },
    timeout: 30,
  });
  const dump2 = JSON.parse(await fs.readFile(path.join(dir, 'env-dump2.json'), 'utf8')) as { token: string | null };
  assert.equal(dump2.token, 'managed-token-xyz');

  // 3) inheritEnv:false: passes only shellEnv + input.env without host baseline
  await server.envExec({
    execId: 't3',
    command: 'node -e \'require("fs").writeFileSync("env-dump3.json", JSON.stringify({hasPath:!!process.env.PATH,hub:process.env.HELMX_HUB_URL??null,custom:process.env.MY_VAR??null}))\'',
    env: { MY_VAR: 'yes' },
    inheritEnv: false,
    timeout: 30,
  });
  const dump3 = JSON.parse(await fs.readFile(path.join(dir, 'env-dump3.json'), 'utf8')) as {
    hasPath: boolean;
    hub: string | null;
    custom: string | null;
  };
  assert.equal(dump3.hasPath, false, 'inheritEnv:false omits host PATH');
  assert.equal(dump3.hub, 'http://hub:3202', 'shellEnv still injected');
  assert.equal(dump3.custom, 'yes', 'input.env injected');
});

// ---------------------------------------------------------------------------
// 3. Output chunking: UTF-16 surrogate pairs (emoji) never split across chunks; cap=1 avoids infinite loop
// ---------------------------------------------------------------------------

test('onExecOutput chunking preserves surrogate pairs across chunk boundaries', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('surrogate-');
  const chunks: string[] = [];
  // Odd small chunk cap + emoji (2 code units) + ASCII forces cuts right between high/low surrogates
  // so safeChunkEnd backs off by one code unit.
  const CHUNK = 7;
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    maxOutputChunkChars: CHUNK,
    onExecOutput: (e) => chunks.push(e.text),
  });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }, { timeout: 60_000 });

  const emoji = '😀'; // U+1F600: high surrogate + low surrogate
  const payload = `AB${emoji}CD${emoji}E${emoji}FG${emoji}H`;
  await fs.writeFile(path.join(dir, 'script.js'), `process.stdout.write(${JSON.stringify(payload)})`);
  const r = await server.envExec({ execId: 's1', command: 'node script.js', timeout: 30 });
  assert.equal(r.ok, true, r.ok ? '' : r.error.message);

  // Concatenation must be lossless (splitting surrogates produces U+FFFD)
  assert.equal(chunks.join(''), payload, 'rejoined chunks must match original string');
  for (const [i, chunk] of chunks.entries()) {
    assert.ok(!chunk.includes('\uFFFD'), `chunk ${i} contains replacement character: ${JSON.stringify(chunk)}`);
    assert.ok(chunk.length <= CHUNK, `chunk ${i} exceeds cap`);
  }
  assert.ok(chunks.length > 1, `should split into multiple chunks (got ${chunks.length})`);
  // Evidence of backing off at a high surrogate: at least one chunk has length CHUNK - 1
  const hasBackoff = chunks.some((c) => c.length === CHUNK - 1);
  assert.ok(hasBackoff, 'at least one chunk backed off by one code unit at surrogate boundary');
});

test('maxOutputChunkChars=1 with emoji advances every step and finishes without infinite loop', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('chunk1-');
  const chunks: string[] = [];
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    maxOutputChunkChars: 1,
    onExecOutput: (e) => chunks.push(e.text),
  });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }, { timeout: 60_000 });

  // Pre-fix bug: safeChunkEnd(text, offset=0, limit=1) backed off to 0 at leading emoji -> end===offset infinite loop.
  const emoji = '🚀';
  const payload = `A${emoji}B${emoji}`;
  await fs.writeFile(path.join(dir, 'script.js'), `process.stdout.write(${JSON.stringify(payload)})`);
  const r = await server.envExec({ execId: 'c1', command: 'node script.js', timeout: 20 });
  assert.equal(r.ok, true, r.ok ? '' : r.error.message);
  assert.equal(server.getActiveExecCount(), 0);
  // With cap=1, an intact surrogate pair is allowed to occupy 2 code units; each chunk is valid UTF-8.
  assert.equal(chunks.map((chunk) => Buffer.from(chunk).toString()).join(''), payload)
  assert.equal(chunks.join(''), payload, 'rejoined chunks must match original string');
  for (const [i, chunk] of chunks.entries()) {
    assert.ok(chunk.length >= 1 && chunk.length <= 2, `chunk ${i} should be a complete code point`);
  }
});

// ---------------------------------------------------------------------------
// 4. onExecOutput callback error: cancels child immediately with callback_error
// ---------------------------------------------------------------------------

test('onExecOutput callback throwing kills process tree immediately with callback_error', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('cb-err-');
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    // Throw on the first callback because multi-line echo output often coalesces into one chunk.
    onExecOutput: () => {
      throw new Error('sink exploded');
    },
  });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }, { timeout: 60_000 });

  // Pre-fix double bug: 1) swallowed callback exceptions let child run until timeout;
  // 2) cancelling inside callback left SDK promise unsettled — race fallback forces callback_error.
  const start = Date.now();
  const r = await server.envExec({
    execId: 'c2',
    command: 'echo line1 && echo line2 && sleep 55',
    timeout: 60,
  });
  const elapsed = Date.now() - start;
  assert.equal(r.ok, false, 'callback failure must not pretend to succeed');
  assert.equal(!r.ok && r.error.code, 'callback_error');
  assert.match(!r.ok ? r.error.message : '', /sink exploded/);
  assert.ok(elapsed < 10_000, `callback failure should kill process tree immediately (actual ${elapsed}ms)`);
  assert.equal(server.getActiveExecCount(), 0, 'cancelled process must leave no active entry');
  // Orphan guard: exact `^sleep 55$` match (without `-f` self-matching pgrep command lines) after kill grace.
  await delay(300);
  const leftover = await new Promise<number>((resolve) => {
    execCb('pgrep -f "^sleep 55$" | grep -cv pgrep || true', (error, stdout) => {
      resolve(error ? -1 : Number.parseInt((stdout || '0').trim(), 10));
    });
  });
  assert.equal(leftover, 0, 'no orphan sleep process should remain after killTree');
});

// ---------------------------------------------------------------------------
// 5. base64 boundary validation: reject invalid characters instead of permissive Node parsing
// ---------------------------------------------------------------------------

test('envWriteFile base64 strict validation rejects illegal characters explicitly as invalid', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('b64-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }, { timeout: 60_000 });

  // Node Buffer.from(x, 'base64') silently ignores '!' etc. — must reject explicitly
  const bad = await server.envWriteFile({ path: 'x.bin', content: 'QQ!Q', encoding: 'base64' });
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.error.code, 'invalid');
  assert.equal(await fs.stat(path.join(dir, 'x.bin')).then(() => true, () => false), false, 'must not write invalid payload');

  // Whitespace in base64 also rejected (permissive parsing skips spaces)
  const space = await server.envWriteFile({ path: 'y.bin', content: 'QQ Q', encoding: 'base64' });
  assert.equal(space.ok, false);
  assert.equal(!space.ok && space.error.code, 'invalid');

  // Valid base64 works normally
  const good = await server.envWriteFile({ path: 'z.bin', content: Buffer.from('ok').toString('base64'), encoding: 'base64' });
  assert.equal(good.ok, true);
  assert.equal(await fs.readFile(path.join(dir, 'z.bin'), 'utf8'), 'ok');

  // Empty content is valid
  const empty = await server.envWriteFile({ path: 'e.bin', content: '', encoding: 'base64' });
  assert.equal(empty.ok, true);
});

// ---------------------------------------------------------------------------
// 6. envExec duplicate execId: rejected explicitly (overwriting drops prior cancel handle)
//    and rejected duplicate calls must not evict live commands from dispose wait set
// ---------------------------------------------------------------------------

test('envExec explicitly rejects duplicate in-flight execId', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('dup-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }, { timeout: 60_000 });

  const slow = server.envExec({ execId: 'dup', command: 'sleep 5', timeout: 30 });
  await delay(200);
  const second = await server.envExec({ execId: 'dup', command: 'echo hi', timeout: 30 });
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.error.code, 'invalid');
  assert.match(!second.ok ? second.error.message : '', /Duplicate execId/);

  await server.envAbortExec('dup');
  const settled = await slow;
  assert.equal(settled.ok, false);
  assert.equal(!settled.ok && settled.error.code, 'aborted');
  assert.equal(server.getActiveExecCount(), 0);
});

test('dispose tracks draining waiters per call so rejected duplicate execId never evicts live commands', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('drain-set-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }, { timeout: 60_000 });

  // Pre-fix bug: Map<execId, Promise> let rejected second call overwrite first promise and remove it
  // from dispose wait set upon early settlement. Switching to Set<Promise> tracks each call independently.
  const slow = server.envExec({ execId: 'd', command: 'sleep 3', timeout: 60 });
  await delay(200);
  const dup = await server.envExec({ execId: 'd', command: 'echo x', timeout: 60 });
  assert.equal(dup.ok, false, 'duplicate execId should be rejected');

  await server.dispose();
  assert.equal(server.getActiveExecCount(), 0, 'dispose waited for genuine in-flight command to settle');
  const r = await slow;
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, 'aborted');
});

// ---------------------------------------------------------------------------
// 7. dispose & upgrade draining for exec and TCP tunnels
// ---------------------------------------------------------------------------

test('dispose waits for active exec calls to settle with zero active entries on return', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('drain-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }, { timeout: 60_000 });

  const slow = server.envExec({ execId: 'd1', command: 'sleep 3', timeout: 60 });
  await delay(250);
  assert.equal(server.getActiveExecCount(), 1);
  await server.dispose();
  assert.equal(server.getActiveExecCount(), 0, 'in-flight exec must be settled and cleaned up before dispose returns');
  const r = await slow;
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, 'aborted');
});

test('upgrade draining covers TCP tunnels: rejects new tunnels while active tunnel continues and cleans up on dispose', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('drain-tcp-');
  const sockets = new Set<net.Socket>();
  const echoServer = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => socket.write(chunk));
  });
  await new Promise<void>((resolve, reject) => {
    echoServer.once('error', reject);
    echoServer.listen(0, '127.0.0.1', resolve);
  });
  const port = (echoServer.address() as net.AddressInfo).port;
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => echoServer.close(() => resolve()));
  }, { timeout: 60_000 });
  const streams: PassThrough[] = [];
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    openTunnelStream: async () => {
      const s = new PassThrough();
      streams.push(s);
      return s;
    },
  });
  t.after(async () => {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }, { timeout: 60_000 });

  const active = await server.nodeTunnelOpen({ tunnelId: 'tcp-live', host: '127.0.0.1', port });
  assert.equal(active.ok, true);
  assert.equal(server.getActiveTunnelCount(), 1);

  server.setDraining(true);
  const rejected = await server.nodeTunnelOpen({ tunnelId: 'tcp-drain', host: '127.0.0.1', port });
  assert.equal(rejected.ok, false);
  assert.equal(!rejected.ok && rejected.error.code, 'node_draining');
  assert.match(!rejected.ok ? rejected.error.message : '', /draining/);
  assert.equal(server.getActiveTunnelCount(), 1, 'draining does not kill existing active TCP tunnel');

  server.setDraining(false);
  const resumed = await server.nodeTunnelOpen({ tunnelId: 'tcp-resumed', host: '127.0.0.1', port });
  assert.equal(resumed.ok, true);
  assert.equal(server.getActiveTunnelCount(), 2);

  await server.dispose();
  assert.equal(server.getActiveTunnelCount(), 0);
  for (const s of streams) assert.equal(s.destroyed, true);
});

test('envCleanup rejects explicitly when draining or disposed (process-tree cwd cleanup)', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('cleanup-guard-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  t.after(async () => {
    await server.dispose().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }, { timeout: 60_000 });

  server.setDraining(true);
  await assert.rejects(
    () => server.envCleanup!(dir),
    (error: unknown) => {
      const err = error as { code?: string; message?: string };
      assert.equal(err.code, 'node_draining');
      assert.match(err.message ?? '', /draining/);
      return true;
    },
  );

  server.setDraining(false);
  await server.envCleanup!(dir);

  await server.dispose();
  await assert.rejects(() => server.envCleanup!(dir), /disposed/);
});

// ---------------------------------------------------------------------------
// 13. birpc events adapter: on/off pairs wrapper references (cleanly removes listeners on $close)
// ---------------------------------------------------------------------------

test('birpc events adapter: off detaches exact wrapped listener independently per route', { timeout: 60_000 }, async () => {
  const { EventEmitter } = await import('node:events');
  const { createSocketBirpcEvents } = await import('../src/daemon/birpc-events.js');
  const socket = new EventEmitter();
  const invalidFrames: string[] = [];
  const events = createSocketBirpcEvents(socket as never, (message) => {
    invalidFrames.push(message);
  });

  const receivedA: unknown[] = [];
  const callbackA = (data: unknown): void => {
    receivedA.push(data);
  };
  events.on(callbackA);
  assert.equal(socket.listenerCount('message'), 1);

  socket.emit('message', Buffer.from(JSON.stringify({ a: 1 })));
  assert.deepEqual(receivedA, [{ a: 1 }]);

  // Malformed JSON or non-object frames go to onInvalidFrame without invoking callback
  socket.emit('message', Buffer.from('not-json'));
  socket.emit('message', Buffer.from('[1,2]'));
  assert.equal(invalidFrames.length, 2);
  assert.deepEqual(receivedA, [{ a: 1 }]);

  const receivedB: unknown[] = [];
  const callbackB = (data: unknown): void => {
    receivedB.push(data);
  };
  events.on(callbackB);
  assert.equal(socket.listenerCount('message'), 2);

  events.off(callbackA);
  assert.equal(socket.listenerCount('message'), 1, 'off must detach the actual wrapped listener');
  socket.emit('message', Buffer.from(JSON.stringify({ b: 2 })));
  assert.deepEqual(receivedA, [{ a: 1 }], 'detached callback must stop receiving frames');
  assert.deepEqual(receivedB, [{ b: 2 }]);

  events.off(callbackB);
  assert.equal(socket.listenerCount('message'), 0, 'zero message listeners remain once all detach ($close semantics)');
  // Detaching unknown callback is a harmless no-op
  events.off(callbackA);
  assert.equal(socket.listenerCount('message'), 0);
});

test('envFor LRU eviction never orphans envs with active runners from envCleanup/dispose, and envListFiles validates input', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('lru-active-');
  const busyDir = path.join(dir, 'busy');
  const otherA = path.join(dir, 'a');
  const otherB = path.join(dir, 'b');
  await fs.mkdir(busyDir, { recursive: true });
  await fs.mkdir(otherA, { recursive: true });
  await fs.mkdir(otherB, { recursive: true });

  const server = createNodeEnvRpcServer({ defaultCwd: dir, maxCachedEnvs: 2 });
  t.after(async () => {
    await server.dispose().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  }, { timeout: 60_000 });

  // Start a long-running exec in `busyDir` and then touch two other cwds beyond maxCachedEnvs=2.
  const slow = server.envExec({ execId: 'lru-busy', command: 'sleep 30', cwd: busyDir, timeout: 60 });
  await delay(150);
  await server.envWriteFile({ path: 'x.txt', content: '1', cwd: otherA });
  await server.envWriteFile({ path: 'y.txt', content: '2', cwd: otherB });

  // `busyDir` env must NOT have been evicted: envCleanup(busyDir) must still kill it promptly.
  const start = Date.now();
  await server.envCleanup(busyDir);
  const res = await slow;
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5_000, `envCleanup(busyDir) should still reach active env after LRU pressure (elapsed=${elapsed}ms)`);
  if (res.ok) assert.notEqual(res.value.exitCode, 0, 'killed child must not exit with code 0');

  // envListFiles rejects missing/non-object/missing-path with invalid, and returns not_supported on valid input.
  const missingArg = await (server.envListFiles as unknown as (input: unknown) => Promise<{ ok: boolean; error?: { code: string } }>)(undefined);
  assert.equal(missingArg.ok, false);
  assert.equal(missingArg.error?.code, 'invalid');
  const missingPath = await (server.envListFiles as unknown as (input: unknown) => Promise<{ ok: boolean; error?: { code: string } }>)({});
  assert.equal(missingPath.ok, false);
  assert.equal(missingPath.error?.code, 'invalid');
  const validUnsupported = await server.envListFiles({ path: '.' });
  assert.equal(validUnsupported.ok, false);
  assert.equal(!validUnsupported.ok && validUnsupported.error.code, 'not_supported');

  // envAppendFile shares strict base64 validation with envWriteFile.
  const badAppend = await server.envAppendFile({ path: 'x.txt', content: 'QQ!Q', encoding: 'base64', cwd: otherA });
  assert.equal(badAppend.ok, false);
  assert.equal(!badAppend.ok && badAppend.error.code, 'invalid');
});

test('reader registry closeAll settles all readers via Promise.allSettled even when a close throws', { timeout: 60_000 }, async () => {
  const { createReaderRegistry } = await import('../src/daemon/env-rpc-readers.js');
  const registry = createReaderRegistry({ maxOpenReaders: 8, readerIdleTtlMs: 60_000, isDisposed: () => false });
  const closed: string[] = [];
  await registry.putReader({
    kind: 'text',
    reader: {
      readLine: async () => ({ ok: true, value: undefined }),
      close: async () => {
        closed.push('r1-throw');
        throw new Error('close boom');
      },
    },
  });
  await registry.putReader({
    kind: 'text',
    reader: {
      readLine: async () => ({ ok: true, value: undefined }),
      close: async () => {
        closed.push('r2-ok');
      },
    },
  });
  const settled = await registry.closeAll();
  assert.deepEqual(closed.sort(), ['r1-throw', 'r2-ok']);
  assert.equal(settled[0]?.status, 'rejected');
  assert.equal(settled[1]?.status, 'fulfilled');
  assert.equal(registry.getOpenReaderCount(), 0);
});
