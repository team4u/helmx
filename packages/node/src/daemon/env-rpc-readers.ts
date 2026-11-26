/**
 * Bounded, idle-TTL-swept reader handle registry for `NodeEnvRpcServer` (`text`, `binary`, `dir`).
 */

import type { BinaryReader, DirReader, TextLineReader } from './local-env.js';

export type ReaderHandle =
  | { kind: 'text'; reader: TextLineReader }
  | { kind: 'binary'; reader: BinaryReader }
  | { kind: 'dir'; reader: DirReader };

interface ReaderEntry {
  handle: ReaderHandle;
  lastUsedAt: number;
}

export interface ReaderRegistryOptions {
  maxOpenReaders: number;
  readerIdleTtlMs: number;
  isDisposed: () => boolean;
}

export interface ReaderRegistry {
  putReader(handle: ReaderHandle): Promise<string>;
  getReader<R extends TextLineReader | BinaryReader | DirReader>(readerId: string, kind: ReaderHandle['kind']): R | undefined;
  closeReader(readerId: string): Promise<void>;
  sweepExpiredReaders(now?: number): void;
  stopSweeper(): void;
  getOpenReaderCount(): number;
  closeAll(): Promise<PromiseSettledResult<void>[]>;
}

/** Create a per-connection reader handle registry with capacity limits and idle-TTL eviction. */
export function createReaderRegistry(options: ReaderRegistryOptions): ReaderRegistry {
  const { maxOpenReaders, readerIdleTtlMs, isDisposed } = options;
  const readers = new Map<string, ReaderEntry>();
  let readerSeq = 0;
  let readerSweeper: NodeJS.Timeout | undefined;

  const stopSweeper = (): void => {
    if (readerSweeper !== undefined) {
      clearInterval(readerSweeper);
      readerSweeper = undefined;
    }
  };

  const stopSweeperIfEmpty = (): void => {
    if (readers.size === 0) stopSweeper();
  };

  const sweepExpiredReaders = (now = Date.now()): void => {
    for (const [id, entry] of [...readers.entries()]) {
      if (now - entry.lastUsedAt < readerIdleTtlMs) continue;
      readers.delete(id);
      void entry.handle.reader.close().catch(() => undefined);
    }
    stopSweeperIfEmpty();
  };

  const ensureSweeper = (): void => {
    if (readerSweeper !== undefined || isDisposed() || readers.size === 0) return;
    const intervalMs = Math.min(30_000, Math.max(25, Math.floor(readerIdleTtlMs / 2)));
    readerSweeper = setInterval(() => sweepExpiredReaders(), intervalMs);
    readerSweeper.unref();
  };

  return {
    async putReader(handle: ReaderHandle): Promise<string> {
      if (isDisposed()) {
        await handle.reader.close();
        throw Object.assign(new Error('server disposed'), { code: 'aborted' });
      }
      const now = Date.now();
      sweepExpiredReaders(now);
      if (readers.size >= maxOpenReaders) {
        await handle.reader.close().catch(() => undefined);
        throw Object.assign(
          new Error(`Too many open readers on node (limit: ${maxOpenReaders})`),
          { code: 'invalid' },
        );
      }
      const id = `r${++readerSeq}`;
      readers.set(id, { handle, lastUsedAt: now });
      ensureSweeper();
      return id;
    },

    getReader<R extends TextLineReader | BinaryReader | DirReader>(
      readerId: string,
      kind: ReaderHandle['kind'],
    ): R | undefined {
      const entry = readers.get(readerId);
      if (entry === undefined) return undefined;
      const now = Date.now();
      if (now - entry.lastUsedAt >= readerIdleTtlMs) {
        readers.delete(readerId);
        stopSweeperIfEmpty();
        void entry.handle.reader.close().catch(() => undefined);
        return undefined;
      }
      if (entry.handle.kind !== kind) return undefined;
      entry.lastUsedAt = now;
      return entry.handle.reader as R;
    },

    async closeReader(readerId: string): Promise<void> {
      const entry = readers.get(readerId);
      if (entry === undefined) return;
      readers.delete(readerId);
      stopSweeperIfEmpty();
      await entry.handle.reader.close().catch(() => undefined);
    },

    sweepExpiredReaders,
    stopSweeper,
    getOpenReaderCount: () => {
      sweepExpiredReaders();
      return readers.size;
    },
    async closeAll(): Promise<PromiseSettledResult<void>[]> {
      stopSweeper();
      const entries = [...readers.values()];
      readers.clear();
      return await Promise.allSettled(entries.map((entry) => entry.handle.reader.close()));
    },
  };
}
