/** 本浏览器已读的 Hub 升级版本（localStorage 读写，纯函数便于测试注入）。 */
import { readStorageItem, writeStorageItem } from '../lib/storage.js'

const SEEN_STORAGE_KEY = 'helmx:hub-changelog-seen'

export function readSeenVersion(): string | null {
  return readStorageItem(SEEN_STORAGE_KEY)
}

export function markSeenVersion(version: string): void {
  writeStorageItem(SEEN_STORAGE_KEY, version)
}
