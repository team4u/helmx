/**
 * Pure diffing, reconciliation, and equality utilities shared across store slices.
 */
import type { ArtifactMetadata, AskSpec, LocalizedText } from '@helmx/protocol/browser'
import type { BackgroundBadgeDocRef, ConversationBackgroundIndex } from '../../shell/background-activity-model.js'
import type { AuthSlice, NotifyPlan, StoreUpdater } from './types.js'

export const ESC_ABORT_NOTICE_ID = 'esc-abort-confirm'
export const EMPTY_PENDING_ASKS: AskSpec[] = Object.freeze([]) as unknown as AskSpec[]
export const EMPTY_BADGE_DOCS: ReadonlyArray<BackgroundBadgeDocRef> = Object.freeze([])
export const EMPTY_PENDING_BADGE_DOCS: ReadonlySet<string> = new Set<string>()
export const EMPTY_BACKGROUND_INDEX: ConversationBackgroundIndex = new Map()

export const ASSET_LOAD_FAILURE_TITLES: ReadonlyArray<LocalizedText> = [
  { en: 'Profiles failed to load', 'zh-CN': '角色加载失败' },
  { en: 'Models failed to load', 'zh-CN': '模型加载失败' },
  { en: 'Providers failed to load', 'zh-CN': '网关加载失败' },
  { en: 'Credentials failed to load', 'zh-CN': '凭据加载失败' },
  { en: 'Skills failed to load', 'zh-CN': '技能加载失败' },
  { en: 'Plugin actions failed to load', 'zh-CN': '插件动作加载失败' },
]

export function emptyPlan(): NotifyPlan {
  return {
    domains: new Set(),
    liveIds: new Set(),
    detailIds: new Set(),
    summaryIds: new Set(),
    artifactIds: new Set(),
    pendingAskIds: new Set(),
    abortedRestoreIds: new Set(),
    highlightIds: new Set(),
    loadErrorKeys: new Set(),
    pluginDocKeys: new Set(),
    pluginIds: new Set(),
  }
}

export function hasNotifyChanges(plan: NotifyPlan): boolean {
  return (
    plan.domains.size > 0 ||
    plan.liveIds.size > 0 ||
    plan.detailIds.size > 0 ||
    plan.summaryIds.size > 0 ||
    plan.artifactIds.size > 0 ||
    plan.pendingAskIds.size > 0 ||
    plan.abortedRestoreIds.size > 0 ||
    plan.highlightIds.size > 0 ||
    plan.loadErrorKeys.size > 0 ||
    plan.pluginDocKeys.size > 0 ||
    plan.pluginIds.size > 0
  )
}

export function mergeNotifyPlan(target: NotifyPlan, source: NotifyPlan): void {
  for (const v of source.domains) target.domains.add(v)
  for (const v of source.liveIds) target.liveIds.add(v)
  for (const v of source.detailIds) target.detailIds.add(v)
  for (const v of source.summaryIds) target.summaryIds.add(v)
  for (const v of source.artifactIds) target.artifactIds.add(v)
  for (const v of source.pendingAskIds) target.pendingAskIds.add(v)
  for (const v of source.abortedRestoreIds) target.abortedRestoreIds.add(v)
  for (const v of source.highlightIds) target.highlightIds.add(v)
  for (const v of source.loadErrorKeys) target.loadErrorKeys.add(v)
  for (const v of source.pluginDocKeys) target.pluginDocKeys.add(v)
  for (const v of source.pluginIds) target.pluginIds.add(v)
}

export function addChangedRecordKeys<V>(
  prev: Record<number, V>,
  next: Record<number, V>,
  out: Set<number>,
): void {
  for (const key of Object.keys(prev)) {
    const id = Number(key)
    if (prev[id] !== next[id]) out.add(id)
  }
  for (const key of Object.keys(next)) {
    const id = Number(key)
    if (prev[id] !== next[id]) out.add(id)
  }
}

export function addChangedStringKeys<V>(
  prev: Record<string, V>,
  next: Record<string, V>,
  out: Set<string>,
): void {
  for (const key of Object.keys(prev)) {
    if (!Object.hasOwn(next, key) || prev[key] !== next[key]) out.add(key)
  }
  for (const key of Object.keys(next)) {
    if (!Object.hasOwn(prev, key) || prev[key] !== next[key]) out.add(key)
  }
}

export function applyUpdater<T>(prev: T, update: StoreUpdater<T>): T {
  return typeof update === 'function' ? (update as (p: T) => T)(prev) : update
}

function sameArtifactMetadata(a: ArtifactMetadata, b: ArtifactMetadata): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.conversationId === b.conversationId &&
      a.kind === b.kind &&
      a.name === b.name &&
      a.path === b.path &&
      a.mimeType === b.mimeType &&
      a.size === b.size &&
      a.createdAt === b.createdAt)
  )
}

/**
 * 复用未变更产物的数组与单项引用：内容完全一致时返回原数组以跳过订阅重渲染，
 * 列表变更时保留未变项原引用，避免预览模态框因元数据引用刷新误重置解码状态。
 */
export function reconcileArtifactList(
  prev: ReadonlyArray<ArtifactMetadata> | undefined,
  next: ArtifactMetadata[],
): ArtifactMetadata[] {
  if (prev === undefined) return next
  const prevById = new Map(prev.map((item) => [item.id, item]))
  let allSame = prev.length === next.length
  const merged = next.map((item, index) => {
    const existing = prevById.get(item.id)
    if (existing !== undefined && sameArtifactMetadata(existing, item)) {
      if (allSame && prev[index] !== existing) allSame = false
      return existing
    }
    allSame = false
    return item
  })
  return allSame ? (prev as ArtifactMetadata[]) : merged
}

export function shallowEqualAuth(a: AuthSlice, b: AuthSlice): boolean {
  return (
    a.authReady === b.authReady &&
    a.authConfigured === b.authConfigured &&
    a.authenticated === b.authenticated &&
    a.authError === b.authError &&
    a.sseConnected === b.sseConnected &&
    a.connectionError === b.connectionError &&
    a.kernelBootId === b.kernelBootId
  )
}

export function isSameAskArray(a: ReadonlyArray<AskSpec>, b: ReadonlyArray<AskSpec>): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function isSameBadgeDocs(
  a: ReadonlyArray<BackgroundBadgeDocRef>,
  b: ReadonlyArray<BackgroundBadgeDocRef>,
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.pluginId !== b[i]!.pluginId || a[i]!.doc !== b[i]!.doc) return false
  }
  return true
}

export function isSameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const key of a) {
    if (!b.has(key)) return false
  }
  return true
}

export function isSameBackgroundIndex(a: ConversationBackgroundIndex, b: ConversationBackgroundIndex): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [id, entry] of a) {
    const other = b.get(id)
    if (other === undefined || other.active !== entry.active || other.summary !== entry.summary) return false
  }
  return true
}
