// @test-isolation: process
/**
 * Isolated SIGINT self-signal test for `helmx-node connect` foreground Ctrl+C shutdown.
 * Kept in its own process-isolated file because it fires `process.kill(process.pid, 'SIGINT')`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import process from 'node:process';
import { WebSocket, WebSocketServer } from 'ws';
import { createBirpc } from 'birpc';
import { makeTempDir as tempDir } from '@helmx/test-kit/node';
import { runNodeCli } from '../src/cli.js';
import { sanitizedHostEnv } from './helpers/sanitized-env.js';

async function startMinimalHub(expectedToken: string): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  server.on('upgrade', (req, socket, head) => {
    if (!(req.url ?? '').startsWith('/ws/node')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.once('close', () => sockets.delete(ws));
      createBirpc(
        {
          register: (input: { nodeId: string; token: string }) =>
            input.token === expectedToken ? { ok: true, heartbeatMs: 60_000 } : { ok: false, heartbeatMs: 0 },
          heartbeat: () => true,
          onEnvExecOutput: () => {},
        },
        {
          post: (data) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
          },
          on: (callback) => {
            ws.on('message', (raw) => {
              const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8');
              try {
                const parsed: unknown = JSON.parse(text);
                if (parsed !== null && typeof parsed === 'object') callback(parsed);
              } catch {
                // Ignore non-JSON frames.
              }
            });
          },
          serialize: (data) => data,
          deserialize: (data) => data as never,
        },
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address !== null && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of sockets) ws.close();
        wss.close(() => undefined);
        server.close(() => resolve());
      }),
  };
}

test('connect foreground prints connecting before registration, ready state after, and exits cleanly on Ctrl+C', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-review-connect-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startMinimalHub('rev-conn:s');
  t.after(async () => {
    await hub.close();
  }, { timeout: 60_000 });
  const outputs: string[] = [];
  let out = '';
  let err = '';
  const code = await runNodeCli(['connect', hub.url, '--token', 'rev-conn:s', '--data-dir', dir], {
    env: sanitizedHostEnv(),
    out: (text) => {
      out += text;
      outputs.push(text);
      // After registered banner prints, simulate Ctrl+C (forwardSignals handles cleanup)
      if (text.includes('registered')) {
        setTimeout(() => process.kill(process.pid, 'SIGINT'), 50);
      }
    },
    err: (text) => {
      err += text;
    },
  });
  assert.equal(code, 0, `${err}\n${out}`);
  assert.match(outputs[0] ?? '', /connecting/, 'first line must say connecting rather than connected');
  assert.ok(outputs.some((text) => text.includes('registered and ready')));
  assert.ok(!outputs.some((text) => text.includes('connected ')), 'must not print bogus connected status');
});
