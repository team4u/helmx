/**
 * Filesystem, streaming reader, and `/proc` path-usage RPC handlers for `NodeEnvRpcServer`.
 */

import { createNodePathUsageIo, scanPathUsage } from '@helmx/env-io';
import type {
  NodeEnvRpcFunctions,
  NodePathUsage,
  RpcResult,
} from '@helmx/protocol';
import { invalidInput, isRecord, rpcFail } from './env-rpc-shared.js';
import type { ReaderRegistry } from './env-rpc-readers.js';
import type { BinaryReader, DirReader, LocalExecutionEnv, TextLineReader } from './local-env.js';

/** Binary transfer payload limit (64 MiB). */
export const MAX_BINARY_TRANSFER_BYTES = 64 * 1024 * 1024;

const readerNotFound = <T>(readerId: string): RpcResult<T> => ({
  ok: false,
  error: { code: 'not_found', message: `Unknown reader: ${readerId}` },
});

/** Strict base64 decoder (standard alphabet + padding, rejecting invalid chars and oversized payloads). */
const decodeBase64 = (content: string, what: string): Uint8Array => {
  if (typeof content !== 'string') {
    throw Object.assign(new Error(`${what} must be a base64 string`), { code: 'invalid' });
  }
  const encodedLimit = Math.ceil(MAX_BINARY_TRANSFER_BYTES / 3) * 4;
  if (content.length > encodedLimit) {
    throw Object.assign(new Error(`${what} exceeds the ${MAX_BINARY_TRANSFER_BYTES} byte transfer limit`), { code: 'invalid' });
  }
  if (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
    throw Object.assign(new Error(`${what} is not valid base64 (standard alphabet)`), { code: 'invalid' });
  }
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
  const decodedBytes = (content.length / 4) * 3 - padding;
  if (decodedBytes > MAX_BINARY_TRANSFER_BYTES) {
    throw Object.assign(
      new Error(`${what} exceeds the ${MAX_BINARY_TRANSFER_BYTES} byte transfer limit (decoded size ~${decodedBytes})`),
      { code: 'invalid' },
    );
  }
  return Buffer.from(content, 'base64');
};

/** Validate and decode UTF-8 or base64 write/append content against the 64 MiB transfer limit. */
const decodeTransferPayload = (
  content: string,
  encoding: 'utf8' | 'base64' | undefined,
): RpcResult<string | Uint8Array> => {
  if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'base64') {
    return invalidInput(`Invalid content encoding: ${String(encoding)}`);
  }
  if (typeof content !== 'string') {
    return invalidInput('content must be a string');
  }
  let bytes: Uint8Array | string;
  try {
    bytes = encoding === 'base64' ? decodeBase64(content, 'content') : content;
  } catch (error) {
    return rpcFail(error);
  }
  const size = typeof bytes === 'string' ? Buffer.byteLength(bytes, 'utf8') : bytes.byteLength;
  if (size > MAX_BINARY_TRANSFER_BYTES) {
    return invalidInput(
      `content is ${size} bytes, exceeding the ${MAX_BINARY_TRANSFER_BYTES} byte transfer limit`,
    );
  }
  return { ok: true, value: bytes };
};

const unwrap = async <T, R = T extends void ? null : T>(
  promise: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>,
): Promise<RpcResult<R>> => {
  const result = await promise;
  return result.ok ? { ok: true, value: (result.value ?? null) as R } : rpcFail(result.error);
};

export type FileAndReaderRpcMethods = Required<
  Pick<
    NodeEnvRpcFunctions,
    | 'envAbsolutePath'
    | 'envJoinPath'
    | 'envReadTextFile'
    | 'envReadTextLines'
    | 'envReadBinaryFile'
    | 'envWriteFile'
    | 'envAppendFile'
    | 'envFlushFile'
    | 'envTruncateFile'
    | 'envRenameFile'
    | 'envFileInfo'
    | 'envListDir'
    | 'envListFiles'
    | 'envCanonicalPath'
    | 'envExists'
    | 'envPathUsage'
    | 'envCreateDir'
    | 'envRemove'
    | 'envCreateTempDir'
    | 'envCreateTempFile'
    | 'envOpenTextLineReader'
    | 'envTextReaderRead'
    | 'envTextReaderClose'
    | 'envOpenBinaryReader'
    | 'envBinaryReaderInfo'
    | 'envBinaryReaderRead'
    | 'envBinaryReaderScanLines'
    | 'envBinaryReaderClose'
    | 'envOpenDirReader'
    | 'envDirReaderNext'
    | 'envDirReaderClose'
  >
>;

export interface FileRpcDeps {
  envFor: (cwd?: string) => LocalExecutionEnv;
  readers: ReaderRegistry;
  pathUsage?: {
    procRoot?: string;
    platform?: () => string;
  };
}

/** Build file, directory, reader, and path-usage RPC handlers backed by `envFor` and `readers`. */
export function createFileRpcMethods(deps: FileRpcDeps): FileAndReaderRpcMethods {
  const { envFor, readers, pathUsage } = deps;

  return {
    async envAbsolutePath({ path: target, cwd }) {
      return unwrap(envFor(cwd).absolutePath(target));
    },
    async envJoinPath({ parts, cwd }) {
      return unwrap(envFor(cwd).joinPath(parts));
    },

    async envReadTextFile({ path: target, cwd }) {
      const env = envFor(cwd);
      const info = await env.fileInfo(target);
      if (info.ok && info.value.size > MAX_BINARY_TRANSFER_BYTES) {
        return invalidInput(`readTextFile result exceeds the ${MAX_BINARY_TRANSFER_BYTES} byte transfer limit`);
      }
      const result = await env.readTextFile(target);
      if (!result.ok) return rpcFail(result.error);
      if (Buffer.byteLength(result.value, 'utf8') > MAX_BINARY_TRANSFER_BYTES) {
        return invalidInput(`readTextFile result exceeds the ${MAX_BINARY_TRANSFER_BYTES} byte transfer limit`);
      }
      return { ok: true, value: result.value };
    },
    async envReadTextLines({ path: target, maxLines, cwd }) {
      return unwrap(envFor(cwd).readTextLines(target, { maxLines }));
    },
    async envReadBinaryFile({ path: target, cwd }) {
      const opened = await envFor(cwd).openBinaryReader(target, {});
      if (!opened.ok) return rpcFail(opened.error);
      const reader = opened.value;
      try {
        const info = await reader.info();
        if (!info.ok) return rpcFail(info.error);
        if (info.value.size > MAX_BINARY_TRANSFER_BYTES) {
          return invalidInput(`readBinaryFile result exceeds the ${MAX_BINARY_TRANSFER_BYTES} byte transfer limit`);
        }
        const result = await reader.read(0, MAX_BINARY_TRANSFER_BYTES + 1);
        if (!result.ok) return rpcFail(result.error);
        if (result.value.byteLength > MAX_BINARY_TRANSFER_BYTES) {
          return invalidInput(`readBinaryFile result exceeds the ${MAX_BINARY_TRANSFER_BYTES} byte transfer limit`);
        }
        return { ok: true, value: { base64: Buffer.from(result.value).toString('base64') } };
      } finally {
        await reader.close();
      }
    },

    async envWriteFile({ path: target, content, encoding, cwd }) {
      const decoded = decodeTransferPayload(content, encoding);
      if (!decoded.ok) return decoded;
      return unwrap(envFor(cwd).writeFile(target, decoded.value));
    },
    async envAppendFile({ path: target, content, encoding, cwd }) {
      const decoded = decodeTransferPayload(content, encoding);
      if (!decoded.ok) return decoded;
      return unwrap(envFor(cwd).appendFile(target, decoded.value));
    },
    async envFlushFile({ path: target, cwd }) {
      return unwrap(envFor(cwd).flushFile(target));
    },
    async envTruncateFile({ path: target, size, cwd }) {
      return unwrap(envFor(cwd).truncateFile(target, size));
    },
    async envRenameFile({ sourcePath, destinationPath, cwd }) {
      return unwrap(envFor(cwd).renameFile(sourcePath, destinationPath));
    },

    async envFileInfo({ path: target, cwd }) {
      return unwrap(envFor(cwd).fileInfo(target));
    },
    async envListDir({ path: target, cwd }) {
      return unwrap(envFor(cwd).listDir(target));
    },
    async envListFiles(input) {
      if (typeof input.path !== 'string') {
        return invalidInput('envListFiles path must be a string');
      }
      // Optional `listFiles` is not implemented on remote nodes; callers fall back to directory walks.
      return { ok: false, error: { code: 'not_supported', message: 'listFiles is not available on this environment' } };
    },
    async envCanonicalPath({ path: target, cwd }) {
      return unwrap(envFor(cwd).canonicalPath(target));
    },
    async envExists({ path: target, cwd }) {
      return unwrap(envFor(cwd).exists(target));
    },

    /** Scan `/proc` via `@helmx/env-io` to report processes referencing `path` (read-only). */
    async envPathUsage(raw: unknown): Promise<RpcResult<NodePathUsage>> {
      if (!isRecord(raw) || Array.isArray(raw)) {
        return invalidInput('envPathUsage input must be a plain object');
      }
      const unknownFields = Object.keys(raw).filter((key) => key !== 'path');
      if (unknownFields.length > 0) {
        return invalidInput(`envPathUsage rejects unknown field(s): ${unknownFields.join(', ')}`);
      }
      const target = (raw as { path?: unknown }).path;
      if (typeof target !== 'string' || target.length === 0 || target.length > 4096 || target.includes('\u0000')) {
        return invalidInput('envPathUsage path must be a non-empty string without NUL, at most 4096 chars');
      }
      const procRoot = pathUsage?.procRoot ?? '/proc';
      const io = createNodePathUsageIo();
      const result = await scanPathUsage(target, {
        io,
        platform: pathUsage?.platform?.() ?? process.platform,
        ...(procRoot === '/proc' ? {} : { procRoot }),
      });
      if (result.ok) return { ok: true, value: result.value };
      const code = result.error.code === 'invalid'
        ? 'invalid'
        : result.error.code === 'not_supported'
          ? 'not_supported'
          : result.error.code === 'permission_denied'
            ? 'permission_denied'
            : result.error.code === 'aborted'
              ? 'aborted'
              : 'unknown';
      return { ok: false, error: { code, message: result.error.message } };
    },

    async envCreateDir({ path: target, recursive, cwd }) {
      return unwrap(envFor(cwd).createDir(target, { recursive }));
    },
    async envRemove({ path: target, recursive, force, cwd }) {
      return unwrap(envFor(cwd).remove(target, { recursive, force }));
    },
    async envCreateTempDir({ prefix, cwd }) {
      return unwrap(envFor(cwd).createTempDir(prefix));
    },
    async envCreateTempFile({ prefix, suffix, cwd }) {
      return unwrap(envFor(cwd).createTempFile({ prefix, suffix }));
    },

    async envOpenTextLineReader({ path: target, cwd }) {
      const result = await envFor(cwd).openTextLineReader(target);
      if (!result.ok) return rpcFail(result.error);
      return { ok: true, value: { readerId: await readers.putReader({ kind: 'text', reader: result.value }) } };
    },
    async envTextReaderRead({ readerId }) {
      const reader = readers.getReader<TextLineReader>(readerId, 'text');
      if (reader === undefined) return readerNotFound(readerId);
      const result = await reader.readLine();
      if (!result.ok) return rpcFail(result.error);
      return { ok: true, value: result.value ?? null };
    },
    async envTextReaderClose({ readerId }) {
      await readers.closeReader(readerId);
      return { ok: true, value: null };
    },

    async envOpenBinaryReader({ path: target, noFollow, cwd }) {
      const result = await envFor(cwd).openBinaryReader(target, { noFollow });
      if (!result.ok) return rpcFail(result.error);
      return { ok: true, value: { readerId: await readers.putReader({ kind: 'binary', reader: result.value }) } };
    },
    async envBinaryReaderInfo({ readerId }) {
      const reader = readers.getReader<BinaryReader>(readerId, 'binary');
      if (reader === undefined) return readerNotFound(readerId);
      return unwrap(reader.info());
    },
    async envBinaryReaderRead({ readerId, offset, length }) {
      const reader = readers.getReader<BinaryReader>(readerId, 'binary');
      if (reader === undefined) return readerNotFound(readerId);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > MAX_BINARY_TRANSFER_BYTES) {
        return invalidInput(
          `length must be a safe integer no greater than ${MAX_BINARY_TRANSFER_BYTES}`,
        );
      }
      const result = await reader.read(offset, length);
      if (!result.ok) return rpcFail(result.error);
      if (result.value.byteLength > MAX_BINARY_TRANSFER_BYTES) {
        return invalidInput(
          `binary reader chunk is ${result.value.byteLength} bytes, exceeding the ${MAX_BINARY_TRANSFER_BYTES} byte transfer limit`,
        );
      }
      return {
        ok: true,
        value: { base64: Buffer.from(result.value).toString('base64'), byteLength: result.value.byteLength },
      };
    },
    async envBinaryReaderScanLines({ readerId, startLine, endLine }) {
      const reader = readers.getReader<BinaryReader>(readerId, 'binary');
      if (reader === undefined) return readerNotFound(readerId);
      return unwrap(reader.scanLines({ startLine, ...(endLine === undefined ? {} : { endLine }) }));
    },
    async envBinaryReaderClose({ readerId }) {
      await readers.closeReader(readerId);
      return { ok: true, value: null };
    },

    async envOpenDirReader({ path: target, cwd }) {
      const result = await envFor(cwd).openDirReader(target);
      if (!result.ok) return rpcFail(result.error);
      return { ok: true, value: { readerId: await readers.putReader({ kind: 'dir', reader: result.value }) } };
    },
    async envDirReaderNext({ readerId, maxEntries }) {
      const reader = readers.getReader<DirReader>(readerId, 'dir');
      if (reader === undefined) return readerNotFound(readerId);
      return unwrap(reader.next(maxEntries));
    },
    async envDirReaderClose({ readerId }) {
      await readers.closeReader(readerId);
      return { ok: true, value: null };
    },
  };
}
