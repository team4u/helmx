/**
 * Reverse WebSocket tunnel client handshake (`/ws/node-tunnel`):
 * opens a dedicated WS stream bound to the active daemon generation, authenticates with
 * `{ nodeId, token, tunnelId }`, validates the first `NodeTunnelControl` frame (`type === 'ok'`),
 * and yields a Node `Duplex` stream via `createWebSocketStream`.
 */

import type { Duplex } from 'node:stream';
import { WebSocket, createWebSocketStream } from 'ws';
import { decodeWsRawData } from './env-rpc-shared.js';

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
  if (signal?.aborted) {
    return Promise.reject(
      Object.assign(new Error('tunnel handshake aborted'), { code: 'aborted' }),
    );
  }
  return new Promise<Duplex>((resolve, reject) => {
    let settled = false;
    let ws: WebSocket | undefined;
    let connectTimer: NodeJS.Timeout | undefined;
    let frameTimer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    let onClose: (() => void) | undefined;

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
      if (onClose !== undefined) ws?.removeListener('close', onClose);
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

    onAbort = (): void => {
      cleanup(Object.assign(new Error('tunnel handshake aborted'), { code: 'aborted' }));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    connectTimer = setTimeout(() => {
      cleanup(Object.assign(new Error(`tunnel WS connect timed out after ${TUNNEL_CONNECT_TIMEOUT_MS}ms`), { code: 'timeout' }));
    }, TUNNEL_CONNECT_TIMEOUT_MS);
    frameTimer = setTimeout(() => {
      cleanup(Object.assign(new Error(`tunnel control frame timed out after ${TUNNEL_FIRST_FRAME_TIMEOUT_MS}ms`), { code: 'timeout' }));
    }, TUNNEL_FIRST_FRAME_TIMEOUT_MS);

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
        const text = decodeWsRawData(raw, TUNNEL_FIRST_FRAME_MAX_BYTES);
        frame = JSON.parse(text);
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        if (code === 'invalid') {
          cleanup(Object.assign(new Error('tunnel control frame exceeds 64KiB limit'), { code: 'invalid' }));
          return;
        }
        cleanup(Object.assign(new Error('tunnel control frame is not valid JSON'), { code: 'invalid' }));
        return;
      }
      const record = frame as { type?: unknown; message?: unknown } | null;
      if (frame === null || typeof frame !== 'object' || typeof record?.type !== 'string') {
        cleanup(Object.assign(new Error('tunnel control frame is not a JSON object'), { code: 'invalid' }));
        return;
      }
      if (record.type === 'ok') {
        if (!isGenerationActive() || signal?.aborted) {
          cleanup(
            Object.assign(
              new Error(
                signal?.aborted
                  ? 'tunnel handshake aborted'
                  : 'tunnel transport unavailable (connection generation retired)',
              ),
              { code: 'aborted' },
            ),
          );
          return;
        }
        if (frameTimer !== undefined) clearTimeout(frameTimer);
        if (connectTimer !== undefined) clearTimeout(connectTimer);
        if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
        ws!.removeListener('message', onMessage);
        ws!.removeListener('error', guardError);
        if (onClose !== undefined) ws!.removeListener('close', onClose);
        settled = true;
        resolve(createWebSocketStream(ws!));
        return;
      }
      if (frameTimer !== undefined) clearTimeout(frameTimer);
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
      ws!.removeListener('message', onMessage);
      ws!.removeListener('error', guardError);
      if (onClose !== undefined) ws!.removeListener('close', onClose);
      ws!.once('error', () => {
        try {
          ws!.terminate();
        } catch {
          // Already destroyed.
        }
      });
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

    onClose = (): void => cleanup();
    ws.on('message', onMessage);
    ws.once('close', onClose);
  });
}
