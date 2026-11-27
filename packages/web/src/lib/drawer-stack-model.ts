/**
 * Pure domain model for the unified right-hand drawer navigation stack
 * (workbench frames + child conversation frames). Zero React/DOM dependencies;
 * shared by helmx-store, url-hash-model, DrawerStackShell, and unit tests.
 */

export const DEFAULT_WORKBENCH_TAB = 'artifacts'
export const MAX_DRAWER_STACK_DEPTH = 5
export const MAX_DRAWER_KEEPALIVE_FRAMES = 3
export const MAX_REMEMBERED_CONVERSATION_DRAWERS = 30

export type DrawerFrame =
  | { kind: 'workbench'; conversationId?: number; tab: string }
  | { kind: 'conversation'; conversationId: number }

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/
const POSITIVE_INT_RE = /^[1-9]\d*$/

function parsePositiveInt(raw: string): number | null {
  if (!POSITIVE_INT_RE.test(raw)) return null
  const num = Number(raw)
  return Number.isSafeInteger(num) && num > 0 ? num : null
}

function isValidTabToken(raw: string): boolean {
  return raw !== '' && !CONTROL_CHAR_RE.test(raw)
}

export function normalizeWorkbenchTab(tab: string | undefined): string {
  if (typeof tab !== 'string') return DEFAULT_WORKBENCH_TAB
  const trimmed = tab.trim()
  return isValidTabToken(trimmed) ? trimmed : DEFAULT_WORKBENCH_TAB
}

export function normalizeDrawerFrame(frame: DrawerFrame): DrawerFrame {
  if (frame.kind === 'conversation') {
    return { kind: 'conversation', conversationId: frame.conversationId }
  }
  const tab = normalizeWorkbenchTab(frame.tab)
  return frame.conversationId !== undefined
    ? { kind: 'workbench', conversationId: frame.conversationId, tab }
    : { kind: 'workbench', tab }
}

export function drawerFrameKey(frame: DrawerFrame): string {
  if (frame.kind === 'conversation') return `c:${frame.conversationId}`
  return `w:${frame.conversationId ?? 'active'}`
}

export function isSameDrawerFrameIdentity(a: DrawerFrame, b: DrawerFrame): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'conversation' && b.kind === 'conversation') {
    return a.conversationId === b.conversationId
  }
  if (a.kind === 'workbench' && b.kind === 'workbench') {
    return a.conversationId === b.conversationId
  }
  return false
}

export function isSameDrawerFrame(a: DrawerFrame, b: DrawerFrame): boolean {
  if (!isSameDrawerFrameIdentity(a, b)) return false
  if (a.kind === 'workbench' && b.kind === 'workbench') {
    return normalizeWorkbenchTab(a.tab) === normalizeWorkbenchTab(b.tab)
  }
  return true
}

export function isSameDrawerStack(a: readonly DrawerFrame[], b: readonly DrawerFrame[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (!isSameDrawerFrame(a[i]!, b[i]!)) return false
  }
  return true
}

/**
 * Push a frame onto the drawer stack:
 * - If a frame with the same identity (`kind` + `conversationId`) is already
 *   present, unwind everything above it and update that slot (prevents A->B->A
 *   nesting loops while letting workbench tab switches update in place).
 * - Otherwise append and drop from the bottom when exceeding `maxDepth`.
 */
export function pushDrawerFrame(
  stack: readonly DrawerFrame[],
  frame: DrawerFrame,
  maxDepth = MAX_DRAWER_STACK_DEPTH,
): DrawerFrame[] {
  const normalized = normalizeDrawerFrame(frame)
  const existingIdx = stack.findIndex((item) => isSameDrawerFrameIdentity(item, normalized))
  if (existingIdx !== -1) {
    if (existingIdx === stack.length - 1 && isSameDrawerFrame(stack[existingIdx]!, normalized)) {
      return stack as DrawerFrame[]
    }
    return [...stack.slice(0, existingIdx), normalized]
  }
  const appended = [...stack, normalized]
  return appended.length > maxDepth ? appended.slice(appended.length - maxDepth) : appended
}

export function popDrawerFrame(stack: readonly DrawerFrame[]): DrawerFrame[] {
  if (stack.length === 0) return stack as DrawerFrame[]
  return stack.slice(0, -1)
}

export function truncateDrawerStackTo(stack: readonly DrawerFrame[], index: number): DrawerFrame[] {
  if (stack.length === 0) return stack as DrawerFrame[]
  const clamped = Math.max(0, Math.min(index, stack.length - 1))
  if (clamped === stack.length - 1) return stack as DrawerFrame[]
  return stack.slice(0, clamped + 1)
}

export function updateTopWorkbenchTab(stack: readonly DrawerFrame[], tab: string): DrawerFrame[] {
  if (stack.length === 0) return stack as DrawerFrame[]
  const top = stack[stack.length - 1]!
  if (top.kind !== 'workbench') return stack as DrawerFrame[]
  const normalizedTab = normalizeWorkbenchTab(tab)
  if (top.tab === normalizedTab) return stack as DrawerFrame[]
  return [...stack.slice(0, -1), { ...top, tab: normalizedTab }]
}

export function removeConversationFromDrawerStack(
  stack: readonly DrawerFrame[],
  conversationId: number,
): DrawerFrame[] {
  const filtered = stack.filter((frame) => frame.conversationId !== conversationId)
  return filtered.length === stack.length ? (stack as DrawerFrame[]) : filtered
}

/**
 * Remember a conversation's docked drawer stack in a bounded LRU map.
 * Empty stacks delete the entry so closed drawers stay closed on return.
 */
export function setRememberedConversationDrawer(
  memory: Map<number, DrawerFrame[]>,
  conversationId: number,
  stack: readonly DrawerFrame[],
  maxEntries = MAX_REMEMBERED_CONVERSATION_DRAWERS,
): void {
  if (stack.length === 0) {
    memory.delete(conversationId)
    return
  }
  const normalized = stack.map(normalizeDrawerFrame)
  memory.delete(conversationId)
  memory.set(conversationId, normalized)
  const cap = Math.max(0, maxEntries)
  while (memory.size > cap) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
  }
}

/**
 * Read a conversation's remembered docked drawer stack (refreshing LRU recency)
 * and return a shallow copy so callers cannot mutate cached entries.
 */
export function getRememberedConversationDrawer(
  memory: Map<number, DrawerFrame[]>,
  conversationId: number,
): DrawerFrame[] | undefined {
  const saved = memory.get(conversationId)
  if (saved === undefined || saved.length === 0) return undefined
  memory.delete(conversationId)
  memory.set(conversationId, saved)
  return [...saved]
}

/**
 * Remove a deleted conversation from the drawer memory: drop its own entry and
 * strip any frame bound to it from other conversations' remembered stacks.
 */
export function pruneConversationFromDrawerMemory(
  memory: Map<number, DrawerFrame[]>,
  deletedConversationId: number,
): void {
  memory.delete(deletedConversationId)
  for (const [ownerId, stack] of [...memory.entries()]) {
    const pruned = removeConversationFromDrawerStack(stack, deletedConversationId)
    if (pruned !== stack) {
      if (pruned.length === 0) memory.delete(ownerId)
      else memory.set(ownerId, pruned)
    }
  }
}

export function topDrawerFrame(stack: readonly DrawerFrame[]): DrawerFrame | undefined {
  return stack.length > 0 ? stack[stack.length - 1] : undefined
}

export function topConversationDrawerId(stack: readonly DrawerFrame[]): number | undefined {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const frame = stack[i]!
    if (frame.kind === 'conversation') return frame.conversationId
  }
  return undefined
}

export function collectDrawerConversationIds(stack: readonly DrawerFrame[]): number[] {
  const ids = new Set<number>()
  for (const frame of stack) {
    if (frame.kind === 'conversation') ids.add(frame.conversationId)
  }
  return [...ids]
}

/**
 * Resolve which conversation a workbench frame at `frameIndex` is bound to:
 * explicit `frame.conversationId` wins; otherwise inherit the nearest
 * conversation frame below it in the stack; otherwise follow the active
 * primary/split conversation.
 */
export function resolveDrawerWorkbenchConversationId(
  stack: readonly DrawerFrame[],
  frameIndex: number,
  activeConversationId: number | undefined,
): number | undefined {
  const frame = stack[frameIndex]
  if (frame === undefined || frame.kind !== 'workbench') return undefined
  if (frame.conversationId !== undefined) return frame.conversationId
  for (let i = frameIndex - 1; i >= 0; i -= 1) {
    const below = stack[i]!
    if (below.kind === 'conversation') return below.conversationId
  }
  return activeConversationId
}

export function isDrawerFrameKeepAlive(
  stackLength: number,
  index: number,
  limit = MAX_DRAWER_KEEPALIVE_FRAMES,
): boolean {
  return index >= Math.max(0, stackLength - limit)
}

/**
 * History policy for drawer stack transitions:
 * - Opening a drawer or pushing deeper (including sliding at maxDepth) -> push
 *   so browser Back steps back one layer;
 * - Popping, breadcrumb truncating, closing all, or switching workbench tabs
 *   in place -> replace so closing never leaves dead forward/back entries.
 */
export function shouldPushDrawerHistory(
  prev: readonly DrawerFrame[],
  next: readonly DrawerFrame[],
): boolean {
  if (isSameDrawerStack(prev, next)) return false
  if (next.length > prev.length) return true
  if (next.length < prev.length) return false
  for (let i = 0; i < prev.length; i += 1) {
    if (!isSameDrawerFrameIdentity(prev[i]!, next[i]!)) return true
  }
  return false
}

export function formatDrawerFrameToken(frame: DrawerFrame): string {
  if (frame.kind === 'conversation') return `c/${frame.conversationId}`
  const tab = normalizeWorkbenchTab(frame.tab)
  return frame.conversationId !== undefined ? `wb@${frame.conversationId}/${tab}` : `wb/${tab}`
}

export function parseDrawerFrameToken(raw: string): DrawerFrame | null {
  if (raw.startsWith('c/')) {
    const conversationId = parsePositiveInt(raw.slice(2))
    return conversationId !== null ? { kind: 'conversation', conversationId } : null
  }
  if (raw.startsWith('wb@')) {
    const rest = raw.slice(3)
    const slash = rest.indexOf('/')
    if (slash <= 0) return null
    const conversationId = parsePositiveInt(rest.slice(0, slash))
    const tab = rest.slice(slash + 1)
    if (conversationId === null || !isValidTabToken(tab)) return null
    return { kind: 'workbench', conversationId, tab }
  }
  if (raw.startsWith('wb/')) {
    const tab = raw.slice(3)
    return isValidTabToken(tab) ? { kind: 'workbench', tab } : null
  }
  return null
}

export function parseDrawerStackTokens(tokens: readonly string[]): DrawerFrame[] {
  let stack: DrawerFrame[] = []
  for (const token of tokens) {
    const parsed = parseDrawerFrameToken(token)
    if (parsed !== null) {
      stack = pushDrawerFrame(stack, parsed)
    }
  }
  return stack
}
