/**
 * Real `node:fs` adapter implementing `PathUsageIo` (`@helmx/env-io`).
 *
 * Shared by `@helmx/kernel` (local Hub scans) and `@helmx/node` (remote daemon) so filesystem
 * semantics are never duplicated. Synchronous `node:fs` syscalls inside async methods avoid
 * libuv fs-threadpool contention when scanning Linux `/proc` across concurrent test workers,
 * while errors preserve their `node:fs` `code` property (`ENOENT`, `EACCES`, `ESRCH`, etc.).
 */
import { readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import type { PathUsageIo } from './path-usage.js'

export function createNodePathUsageIo(): PathUsageIo {
  return {
    readlink: async (p) => readlinkSync(p),
    readdir: async (p) => readdirSync(p),
    stat: async (p) => ({ uid: statSync(p).uid }),
    readFile: async (p) => readFileSync(p, 'utf8'),
    realpath: async (p) => realpathSync(p),
  }
}
