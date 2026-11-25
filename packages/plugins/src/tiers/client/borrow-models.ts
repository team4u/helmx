/**
 * Pure data models, boundary parsers, draftMeta helpers, and panel-isolated
 * picker-open event bus for builtin:tiers model borrow UI.
 * Browser-safe, zero React component exports (Fast Refresh compliant).
 */
import type { ConversationSummary } from '@helmx/protocol/browser'
import { formatModelShortName } from '@helmx/plugin-client'

export const TIERS_BORROW_SESSION_DOC = 'borrow' as const
export const TIERS_BORROW_COMMAND_ID = 'borrow-model' as const
export const TIERS_BORROW_COMMAND_SLASH = 'model' as const
export const TIERS_SWITCH_MODEL_TOOL = 'switch_model' as const
export const TIERS_INPUT_META_KEY = 'builtin:tiers' as const
export const TIERS_BORROW_OPEN_EVENT = 'helmx:tiers-borrow-open' as const

export type TierBorrowPhase = 'armed' | 'active'
export type HelmxBorrowPanel = 'primary' | 'split'

export interface TierBorrowSessionView {
  phase: TierBorrowPhase
  requestedRef: string
  targetModel: string
  targetConcreteModel: string
  targetLabel: string
  targetTierId?: string
  effort?: string
  restoreAfterTurn: boolean
  previousModelOverride?: string
  updatedAt: number
}

export interface SwitchModelPresentationMeta {
  fromModel: string
  toModel: string
  toLabel: string
  tierId?: string
  effort?: string
  restoreAfterTurn: boolean
  changed: boolean
}

export interface StandbyBorrowDraft {
  borrowModel: string
  effort?: string
}

const VALID_THINKING_LEVELS: ReadonlySet<string> = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function isTiersBorrowEligibleConversation(
  conv: Pick<ConversationSummary, 'parentConversationId' | 'ownedBy'> | undefined,
): boolean {
  return conv !== undefined && conv.parentConversationId === undefined && (conv.ownedBy ?? 'human') === 'human'
}

export function isConversationBusyForBorrow(
  conv: Pick<ConversationSummary, 'status' | 'pendingAskCount' | 'contextUsage'> | undefined,
): boolean {
  if (conv === undefined) return false
  return (
    conv.status === 'working' ||
    conv.status === 'blocked' ||
    conv.pendingAskCount > 0 ||
    conv.contextUsage?.compacting === true
  )
}

export function parseTierBorrowSessionView(raw: unknown): TierBorrowSessionView | null {
  if (!isRecord(raw)) return null
  const phase = raw['phase']
  if (phase !== 'armed' && phase !== 'active') return null
  const requestedRef = raw['requestedRef']
  const targetModel = raw['targetModel']
  const targetConcreteModel = raw['targetConcreteModel']
  const targetLabel = raw['targetLabel']
  const restoreAfterTurn = raw['restoreAfterTurn']
  const updatedAt = raw['updatedAt']
  if (
    typeof requestedRef !== 'string' ||
    requestedRef === '' ||
    typeof targetModel !== 'string' ||
    targetModel === '' ||
    typeof targetConcreteModel !== 'string' ||
    targetConcreteModel === '' ||
    typeof targetLabel !== 'string' ||
    targetLabel === '' ||
    typeof restoreAfterTurn !== 'boolean' ||
    typeof updatedAt !== 'number' ||
    !Number.isFinite(updatedAt)
  ) {
    return null
  }
  const targetTierId =
    typeof raw['targetTierId'] === 'string' && raw['targetTierId'] !== ''
      ? raw['targetTierId']
      : undefined
  const effort =
    typeof raw['effort'] === 'string' && VALID_THINKING_LEVELS.has(raw['effort'])
      ? raw['effort']
      : undefined
  const previousModelOverride =
    typeof raw['previousModelOverride'] === 'string' ? raw['previousModelOverride'] : undefined
  return {
    phase,
    requestedRef,
    targetModel,
    targetConcreteModel,
    targetLabel,
    ...(targetTierId !== undefined ? { targetTierId } : {}),
    ...(effort !== undefined ? { effort } : {}),
    restoreAfterTurn,
    ...(previousModelOverride !== undefined ? { previousModelOverride } : {}),
    updatedAt,
  }
}

export function parseSwitchModelPresentationMeta(raw: unknown): SwitchModelPresentationMeta | undefined {
  if (!isRecord(raw)) return undefined
  const fromModel = raw['fromModel']
  const toModel = raw['toModel']
  const toLabel = raw['toLabel']
  const restoreAfterTurn = raw['restoreAfterTurn']
  const changed = raw['changed']
  if (
    typeof fromModel !== 'string' ||
    typeof toModel !== 'string' ||
    toModel === '' ||
    typeof toLabel !== 'string' ||
    toLabel === '' ||
    typeof restoreAfterTurn !== 'boolean' ||
    typeof changed !== 'boolean'
  ) {
    return undefined
  }
  const tierId =
    typeof raw['tierId'] === 'string' && raw['tierId'] !== '' ? raw['tierId'] : undefined
  const effort =
    typeof raw['effort'] === 'string' && VALID_THINKING_LEVELS.has(raw['effort'])
      ? raw['effort']
      : undefined
  return {
    fromModel,
    toModel,
    toLabel,
    ...(tierId !== undefined ? { tierId } : {}),
    ...(effort !== undefined ? { effort } : {}),
    restoreAfterTurn,
    changed,
  }
}

export function readStandbyBorrowDraft(
  draftMeta: Readonly<Record<string, unknown>> | undefined,
): StandbyBorrowDraft | null {
  if (!isRecord(draftMeta)) return null
  const entry = draftMeta[TIERS_INPUT_META_KEY]
  if (!isRecord(entry)) return null
  const rawModel = entry['borrowModel']
  if (typeof rawModel !== 'string' || rawModel.trim() === '') return null
  const rawEffort = entry['effort']
  const effort =
    typeof rawEffort === 'string' && VALID_THINKING_LEVELS.has(rawEffort.trim())
      ? rawEffort.trim()
      : undefined
  return {
    borrowModel: rawModel.trim(),
    ...(effort !== undefined ? { effort } : {}),
  }
}

export function makeStandbyBorrowMetaValue(
  model: string,
  effort: string | null | undefined,
): StandbyBorrowDraft {
  const trimmedModel = model.trim()
  const trimmedEffort =
    typeof effort === 'string' && VALID_THINKING_LEVELS.has(effort.trim())
      ? effort.trim()
      : undefined
  return {
    borrowModel: trimmedModel,
    ...(trimmedEffort !== undefined ? { effort: trimmedEffort } : {}),
  }
}

export function formatBorrowTargetLabel(modelRef: string, effort?: string): string {
  const short = formatModelShortName(modelRef) || modelRef.trim()
  return effort !== undefined && effort !== '' ? `${short} · ${effort}` : short
}

export function extractFallbackSwitchModelTarget(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined
  const model = input['model']
  if (typeof model !== 'string' || model.trim() === '') return undefined
  const effort = typeof input['effort'] === 'string' && input['effort'].trim() !== '' ? input['effort'].trim() : undefined
  return formatBorrowTargetLabel(model.trim(), effort)
}

export function extractFirstErrorLine(raw: unknown): string | undefined {
  let text = ''
  if (typeof raw === 'string') {
    text = raw
  } else if (Array.isArray(raw)) {
    for (const block of raw) {
      if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
        text = block['text']
        break
      }
    }
  }
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0)
  return line !== undefined ? line.slice(0, 140) : undefined
}

/** Resolve the owning host panel (`primary` | `split`) for panel-isolated menu -> toolbar events. */
export function resolveBorrowPanel(
  el: Element | null | undefined,
  options?: { checkOpenPlusTrigger?: boolean },
): HelmxBorrowPanel {
  const ownAttr = el?.closest?.('[data-helmx-panel]')?.getAttribute('data-helmx-panel')
  if (ownAttr === 'primary' || ownAttr === 'split') return ownAttr
  if (options?.checkOpenPlusTrigger === true && typeof document !== 'undefined') {
    const triggerAttr = document
      .querySelector('.composer-plus-trigger[data-state="open"]')
      ?.closest?.('[data-helmx-panel]')
      ?.getAttribute('data-helmx-panel')
    if (triggerAttr === 'primary' || triggerAttr === 'split') return triggerAttr
  }
  return 'primary'
}

export function makeBorrowScopeKey(
  panel: HelmxBorrowPanel,
  target: { conversationId: number } | { profileId: string },
): string {
  return 'conversationId' in target
    ? `${panel}:conv:${target.conversationId}`
    : `${panel}:standby:${target.profileId}`
}

export function emitBorrowPickerOpen(scopeKey: string): void {
  if (typeof window === 'undefined') return
  const EventCtor = typeof window.CustomEvent === 'function' ? window.CustomEvent : CustomEvent
  window.dispatchEvent(new EventCtor(TIERS_BORROW_OPEN_EVENT, { detail: { scopeKey } }))
}

export function subscribeBorrowPickerOpen(
  getScopeKey: () => string,
  onOpen: () => void,
): () => void {
  if (typeof window === 'undefined') return () => {}
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<{ scopeKey?: unknown } | undefined>).detail
    if (detail !== undefined && detail !== null && detail.scopeKey === getScopeKey()) {
      onOpen()
    }
  }
  window.addEventListener(TIERS_BORROW_OPEN_EVENT, listener)
  return () => window.removeEventListener(TIERS_BORROW_OPEN_EVENT, listener)
}
