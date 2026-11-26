/**
 * Shared RPC error envelope, validation, and WS frame helpers used by `env-rpc-server`,
 * `env-rpc-tunnel`, `tunnel-client`, and `birpc-events` so error codes and frame decoding share one source of truth.
 */
import type { RpcEnvError, RpcResult } from '@helmx/protocol';

export type RpcErrorCode = RpcEnvError['code'];

/** Decode `ws` RawData (`string | Buffer | Buffer[] | ArrayBuffer | ArrayBufferView`) safely to UTF-8. */
export const decodeWsRawData = (raw: unknown, maxBytes?: number): string => {
  if (typeof raw === 'string') {
    if (maxBytes !== undefined && Buffer.byteLength(raw, 'utf8') > maxBytes) {
      throw Object.assign(new Error(`frame exceeds ${maxBytes} byte limit`), { code: 'invalid' });
    }
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    if (maxBytes !== undefined && raw.byteLength > maxBytes) {
      throw Object.assign(new Error(`frame exceeds ${maxBytes} byte limit`), { code: 'invalid' });
    }
    return raw.toString('utf8');
  }
  if (Array.isArray(raw)) {
    const buffers: Buffer[] = [];
    let totalBytes = 0;
    for (const part of raw) {
      let buf: Buffer;
      if (Buffer.isBuffer(part)) buf = part;
      else if (part instanceof ArrayBuffer) buf = Buffer.from(part);
      else if (ArrayBuffer.isView(part)) buf = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
      else throw Object.assign(new Error('unsupported WebSocket frame fragment'), { code: 'invalid' });
      totalBytes += buf.byteLength;
      if (maxBytes !== undefined && totalBytes > maxBytes) {
        throw Object.assign(new Error(`frame exceeds ${maxBytes} byte limit`), { code: 'invalid' });
      }
      buffers.push(buf);
    }
    return Buffer.concat(buffers, totalBytes).toString('utf8');
  }
  if (raw instanceof ArrayBuffer) {
    if (maxBytes !== undefined && raw.byteLength > maxBytes) {
      throw Object.assign(new Error(`frame exceeds ${maxBytes} byte limit`), { code: 'invalid' });
    }
    return Buffer.from(raw).toString('utf8');
  }
  if (ArrayBuffer.isView(raw)) {
    if (maxBytes !== undefined && raw.byteLength > maxBytes) {
      throw Object.assign(new Error(`frame exceeds ${maxBytes} byte limit`), { code: 'invalid' });
    }
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  }
  throw Object.assign(new Error('unsupported WebSocket frame payload'), { code: 'invalid' });
};

/** Standard `node_draining` error envelope returned when rejecting new work during upgrade drain. */
export const drainingRejection = (what: string): RpcEnvError => ({
  code: 'node_draining',
  message: `daemon is draining (upgrade in progress), rejecting new ${what}`,
});

export const toRpcError = (error: unknown): RpcEnvError => {
  const anyError = error as { code?: string; message?: string; spillPath?: string } | null;
  if (anyError && typeof anyError === 'object' && anyError.code && anyError.message !== undefined) {
    return {
      code: anyError.code as RpcErrorCode,
      message: anyError.message,
      ...(anyError.spillPath !== undefined ? { spillPath: anyError.spillPath } : {}),
    };
  }
  return { code: 'unknown', message: error instanceof Error ? error.message : String(error) };
};

export const rpcFail = <T>(error: unknown): RpcResult<T> => ({ ok: false, error: toRpcError(error) });

export const invalidInput = <T>(message: string): RpcResult<T> => ({
  ok: false,
  error: { code: 'invalid', message },
});

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
