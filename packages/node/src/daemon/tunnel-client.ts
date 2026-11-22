/**
 * Reverse WebSocket tunnel client handshake (`/ws/node-tunnel`):
 * opens a dedicated WS stream bound to the active daemon generation, authenticates with
 * `{ nodeId, token, tunnelId }`, validates the first `NodeTunnelControl` frame (`type === 'ok'`),
 * and yields a Node `Duplex` stream via `createWebSocketStream`.
 */

import type { Duplex } from 'node:stream';
import { WebSocket, createWebSocketStream } from 'ws';

const TUNNEL_CONNECT_TIMEOUT_MS = 10_000;
const TUNNEL_FIRST_FRAME_TIMEOUT_MS = 15_000;
const TUNNEL_FIRST_FRAME_MAX_BYTES = 64 * 1024;

export interface OpenNodeTunnelOptions {
  tunnelWsUrl: string;
  nodeId: string;
  token: string;
  tunnelId: string;
  isGenerationActive: () => boolean;
  signal?: AbortSignal;
}

export function openNodeTunnelStream(options: OpenNodeTunnelOptions): Promise<Duplex> {
  const { tunnelWsUrl, nodeId, token, tunnelId, isGenerationActive, signal } = options;
  if (!isGenerationActive()) {
    return Promise.reject(
      Object.assign(new Error('tunnel transport unavailable (connection generation retired)'), { code: 'aborted' }),
    );
  }
  return new Promise<Duplex>((resolve, reject) => {
    let settled = false;
    let ws: WebSocket | undefined;
    let connectTimer: NodeJS.Timeout | undefined;
    let frameTimer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;

    const guardError = (err: Error): void => {
      if (settled) {
        try {
          ws?.terminate();
        } catch {
          // Already destroyed.
        }
        return;
      }
      cleanup(err);
    };

    const cleanup = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      if (frameTimer !== undefined) clearTimeout(frameTimer);
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
      ws?.removeAllListeners('message');
      ws?.removeAllListeners('open');
      ws?.removeListener('error', guardError);
      ws?.once('error', () => {
        try {
          ws?.terminate();
        } catch {
          // Already destroyed.
        }
      });
      if (signal?.aborted) ws?.terminate();
      else {
        try {
          ws?.close();
        } catch {
          ws?.terminate();
        }
      }
      reject(
        error ??
          Object.assign(
            new Error('tunnel WebSocket closed before handshake completed'),
            { code: 'aborted' },
          ),
      );
    };

    connectTimer = setTimeout(() => {
      cleanup(Object.assign(new Error(`tunnel WS connect timed out after ${TUNNEL_CONNECT_TIMEOUT_MS}ms`), { code: 'timeout' }));
    }, TUNNEL_CONNECT_TIMEOUT_MS);
    frameTimer = setTimeout(() => {
      cleanup(Object.assign(new Error(`tunnel control frame timed out after ${TUNNEL_FIRST_FRAME_TIMEOUT_MS}ms`), { code: 'timeout' }));
    }, TUNNEL_FIRST_FRAME_TIMEOUT_MS);
    onAbort = (): void => {
      cleanup(Object.assign(new Error('tunnel handshake aborted'), { code: 'aborted' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      ws = new WebSocket(tunnelWsUrl);
    } catch (error) {
      cleanup(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    ws.on('error', guardError);
    ws.once('open', () => {
      if (connectTimer !== undefined) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
      if (settled) return;
      ws!.send(JSON.stringify({ nodeId, token, tunnelId }));
    });

    const onMessage = (raw: unknown): void => {
      if (settled) return;
      let frame: unknown;
      try {
        const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8');
        if (Buffer.byteLength(text, 'utf8') > TUNNEL_FIRST_FRAME_MAX_BYTES) {
          cleanup(Object.assign(new Error('tunnel control frame exceeds 64KiB limit'), { code: 'invalid' }));
          return;
        }
        frame = JSON.parse(text);
      } catch {
        cleanup(Object.assign(new Error('tunnel control frame is not valid JSON'), { code: 'invalid' }));
        return;
      }
      const record = frame as { type?: unknown; message?: unknown } | null;
      if (frame === null || typeof frame !== 'object' || typeof record?.type !== 'string') {
        cleanup(Object.assign(new Error('tunnel control frame is not a JSON object'), { code: 'invalid' }));
        return;
      }
      if (frameTimer !== undefined) clearTimeout(frameTimer);
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
      ws!.removeListener('message', onMessage);
      if (record.type === 'ok') {
        settled = true;
        resolve(createWebSocketStream(ws!));
        return;
      }
      const detail = typeof record.message === 'string' ? record.message : JSON.stringify(frame).slice(0, 200);
      settled = true;
      try {
        ws!.close();
      } catch {
        ws!.terminate();
      }
      reject(
        Object.assign(new Error(`tunnel handshake rejected: ${detail}`), {
          code: record.type === 'timeout' ? 'timeout' : 'invalid',
        }),
      );
    };

    ws.on('message', onMessage);
    ws.once('close', () => cleanup());
  });
}
