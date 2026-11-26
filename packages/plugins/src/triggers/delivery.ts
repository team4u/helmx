/**
 * triggers/delivery.ts: shared delivery, overlap inspection, and isolated-run retention for cron and webhook.
 *
 * Target semantics:
 * - `kind: 'conversation'`: deliver directly to an explicit existing conversation with `whenBusy: 'followUp'`
 *   (deleted/missing targets fail loudly with 404, never silently rerouted);
 * - `kind: 'isolated'`: validate target Profile exists, create a fresh `ownedBy: 'helmx'` conversation tagged
 *   `[TRIGGER_TAG, triggerSourceTag(kind, id)]`, dispatch with `whenBusy: 'followUp'`, and best-effort prune excess
 *   older settled runs beyond `keepLast`;
 * - `kind: 'dedicated'`: validate target Profile exists, resolve or single-flight create one dedicated
 *   `ownedBy: 'helmx'` conversation for this trigger, persist its binding via `onDedicatedConversationId`,
 *   and dispatch with `whenBusy: 'followUp'`.
 * - Text passes through raw (kernel `dispatchTrigger` applies the unified defang anti-escape wrapping once).
 */
import { HelmxError } from '@helmx/protocol'
import type { ConversationSummary, ExternalTriggerEnvelope } from '@helmx/protocol'
import { errorMessageOf, isConversationNotFoundError } from '../shared-helpers.js'
import {
  DEFAULT_TRIGGER_KEEP_LAST,
  DEFAULT_TRIGGER_PROFILE_ID,
  TRIGGER_TAG,
  assertTriggerProfileId,
  triggerSourceTag,
  type ConversationLookup,
  type ProfileLookup,
  type TriggerKind,
  type TriggerSessionMode,
} from './contracts.js'

export type TriggerDeliveryTarget =
  | {
      kind: 'conversation'
      conversationId: number
    }
  | {
      kind: 'isolated'
      triggerKind: TriggerKind
      triggerId: string
      label?: string
      timezone?: string
      profileId?: string
      keepLast?: number
    }
  | {
      kind: 'dedicated'
      triggerKind: TriggerKind
      triggerId: string
      label?: string
      profileId?: string
      dedicatedConversationId?: number
      onDedicatedConversationId?: (conversationId: number) => Promise<void> | void
    }

export interface TriggerDispatchResult {
  conversationId: number
}

export type DispatchTriggerHelper = (
  event: ExternalTriggerEnvelope,
  target: TriggerDeliveryTarget,
) => Promise<TriggerDispatchResult>

/** Formats a concise local timestamp (`MM-DD HH:mm`) in the given IANA timezone for isolated run titles. */
export function formatRunTimestamp(epochMs: number, timezone = 'UTC'): string {
  const date = new Date(epochMs)
  if (Number.isNaN(date.getTime())) return ''
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date)
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
    const month = get('month')
    const day = get('day')
    const hour = get('hour') === '24' ? '00' : get('hour')
    const minute = get('minute')
    if (month && day && hour && minute) {
      return `${month}-${day} ${hour}:${minute}`
    }
  } catch {
    // Fall back to ISO UTC slice when timezone formatting is unavailable.
  }
  return date.toISOString().slice(5, 16).replace('T', ' ')
}

/** Builds a scannable title for an automated trigger conversation. */
export function formatTriggerConversationTitle(input: {
  triggerKind: TriggerKind
  triggerId: string
  label?: string
  isolatedAt?: number
  timezone?: string
}): string {
  const rawName = input.label?.trim() || input.triggerId
  const name = rawName.length > 48 ? `${rawName.slice(0, 47)}…` : rawName
  const prefix = `[${input.triggerKind}] ${name}`
  if (input.isolatedAt === undefined) return prefix
  const stamp = formatRunTimestamp(input.isolatedAt, input.timezone)
  return stamp ? `${prefix} · ${stamp}` : prefix
}

/**
 * Finds an active (`working` | `blocked` | pending Ask) root run belonging to the given trigger.
 * Used by the cron scheduler to skip overlapping scheduled ticks while a slow previous run is still in flight.
 */
export function findActiveTriggerRun(
  host: Pick<ConversationLookup, 'listConversations'>,
  triggerKind: TriggerKind,
  triggerId: string,
): ConversationSummary | undefined {
  const sourceTag = triggerSourceTag(triggerKind, triggerId)
  const active = host
    .listConversations({ tag: sourceTag, topLevelOnly: true })
    .filter(
      (c) =>
        c.parentConversationId === undefined &&
        (c.status === 'working' || c.status === 'blocked' || c.pendingAskCount > 0),
    )
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
  return active[0]
}

const PRUNE_BENIGN_ERROR_CODES = new Set([
  'not_found',
  'ownership_conflict',
  'conversation_active',
  'conversation_managed_by_plugin',
  'runtime_closing',
  'plugin_disabled',
  'not_supported',
])

/**
 * Prunes excess settled isolated runs for a trigger via kernel `deleteConversationGuarded`:
 * - Only touches top-level `ownedBy === 'helmx'` conversations carrying `triggerSourceTag(kind, id)`;
 * - Never deletes `working`, `blocked`, `error`, pending-ask, or `excludeConversationId` conversations;
 * - Keeps the newest `keepLast` settled runs (or `keepLast - 1` when `reserveSlotForActive` is true).
 */
export async function pruneIsolatedRuns(
  host: Pick<ConversationLookup, 'listConversations' | 'deleteConversationGuarded'>,
  triggerKind: TriggerKind,
  triggerId: string,
  keepLast: number,
  options?: { excludeConversationId?: number; reserveSlotForActive?: boolean },
): Promise<number> {
  if (host.deleteConversationGuarded === undefined) return 0
  const sourceTag = triggerSourceTag(triggerKind, triggerId)
  const cap = Math.max(0, options?.reserveSlotForActive ? keepLast - 1 : keepLast)
  const eligible = host
    .listConversations({ tag: sourceTag, ownedBy: 'helmx', topLevelOnly: true })
    .filter(
      (c) =>
        c.parentConversationId === undefined &&
        (c.ownedBy ?? 'human') === 'helmx' &&
        c.id !== options?.excludeConversationId &&
        c.status !== 'working' &&
        c.status !== 'blocked' &&
        c.status !== 'error' &&
        c.pendingAskCount === 0,
    )
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)

  const toDelete = eligible.slice(cap)
  let deleted = 0
  for (const conv of toDelete) {
    try {
      await host.deleteConversationGuarded(conv.id, { expectedOwnership: 'helmx' })
      deleted += 1
    } catch (err) {
      if (err instanceof HelmxError && PRUNE_BENIGN_ERROR_CODES.has(err.code)) {
        continue
      }
      console.error(`[triggers] failed to prune old ${sourceTag} run #${conv.id}: ${errorMessageOf(err)}`)
    }
  }
  return deleted
}

export interface TriggerDeliverySource {
  triggerKind: TriggerKind
  id: string
  description?: string
  timezone?: string
  targetConversationId?: number
  mode?: TriggerSessionMode
  profileId?: string
  keepLast?: number
  dedicatedConversationId?: number
  onDedicatedConversationId: (conversationId: number) => Promise<void>
}

/** Validate an explicit trigger `profileId` against `profiles`, rejecting unknown IDs cleanly. */
export async function assertTriggerProfileExists(
  profiles: ProfileLookup | undefined,
  profileId: string | undefined,
  reason: string,
): Promise<void> {
  if (profileId === undefined || profiles === undefined) return
  if ((await profiles.get(profileId)) === undefined) {
    throw new HelmxError(
      'validation_error',
      `profileId does not exist: ${profileId} (${reason})`,
      400,
      { profileId },
    )
  }
}

/** Construct a uniform delivery target for a cron job or webhook endpoint. */
export function buildTriggerDeliveryTarget(source: TriggerDeliverySource): TriggerDeliveryTarget {
  if (source.targetConversationId !== undefined) {
    return { kind: 'conversation', conversationId: source.targetConversationId }
  }
  if (source.mode === 'dedicated') {
    return {
      kind: 'dedicated',
      triggerKind: source.triggerKind,
      triggerId: source.id,
      label: source.description,
      profileId: source.profileId,
      dedicatedConversationId: source.dedicatedConversationId,
      onDedicatedConversationId: source.onDedicatedConversationId,
    }
  }
  return {
    kind: 'isolated',
    triggerKind: source.triggerKind,
    triggerId: source.id,
    label: source.description,
    ...(source.timezone !== undefined ? { timezone: source.timezone } : {}),
    profileId: source.profileId,
    keepLast: source.keepLast ?? DEFAULT_TRIGGER_KEEP_LAST,
  }
}

export function createDeliveryDispatch(options: {
  host: {
    dispatchTrigger(event: ExternalTriggerEnvelope): Promise<void>
  } & ConversationLookup
  profiles: ProfileLookup
  /** Host closing state (the ctx.host.isClosing getter). */
  isClosing(): boolean
}): DispatchTriggerHelper {
  const { host, profiles, isClosing } = options
  /** Per-trigger single-flight creation map for dedicated mode (prevents concurrent bursts creating duplicates). */
  const dedicatedInflight = new Map<string, Promise<number>>()

  return async (event, target) => {
    if (isClosing()) {
      throw new HelmxError('runtime_closing', 'the runtime is closing; new trigger deliveries are rejected', 409, {
        source: event.source,
      })
    }

    if (target.kind === 'conversation') {
      assertConversationExists(host, target.conversationId)
      if (isClosing()) {
        throw new HelmxError('runtime_closing', 'the runtime is closing; new trigger deliveries are rejected', 409, {
          source: event.source,
        })
      }
      await host.dispatchTrigger({
        ...event,
        targetConversationId: target.conversationId,
        whenBusy: event.whenBusy ?? 'followUp',
      })
      return { conversationId: target.conversationId }
    }

    const effectiveProfileId = assertTriggerProfileId(target.profileId ?? DEFAULT_TRIGGER_PROFILE_ID)
    await assertTriggerProfileExists(profiles, effectiveProfileId, 'refusing to deliver to the wrong role')

    if (isClosing()) {
      throw new HelmxError('runtime_closing', 'the runtime is closing; new trigger deliveries are rejected', 409, {
        source: event.source,
      })
    }

    if (target.kind === 'isolated') {
      const sourceTag = triggerSourceTag(target.triggerKind, target.triggerId)
      const created = await host.createConversation({
        title: formatTriggerConversationTitle({
          triggerKind: target.triggerKind,
          triggerId: target.triggerId,
          label: target.label,
          isolatedAt: event.createdAt,
          timezone: target.timezone,
        }),
        profileId: effectiveProfileId,
        tags: [TRIGGER_TAG, sourceTag],
        ownedBy: 'helmx',
      })
      if (created.ownedBy !== 'helmx') {
        host.markConversationOwnership?.(created.id, 'helmx')
      }
      try {
        if (isClosing()) {
          throw new HelmxError('runtime_closing', 'the runtime is closing; new trigger deliveries are rejected', 409, {
            source: event.source,
          })
        }
        await host.dispatchTrigger({
          ...event,
          targetConversationId: created.id,
          whenBusy: event.whenBusy ?? 'followUp',
        })
      } catch (err) {
        // Best-effort cleanup of the brand-new empty isolated conversation when dispatch fails.
        if (host.deleteConversationGuarded !== undefined) {
          await host.deleteConversationGuarded(created.id, { expectedOwnership: 'helmx' }).catch(() => {})
        }
        throw err
      }
      const keepLast = target.keepLast ?? DEFAULT_TRIGGER_KEEP_LAST
      await pruneIsolatedRuns(host, target.triggerKind, target.triggerId, keepLast, {
        excludeConversationId: created.id,
        reserveSlotForActive: true,
      })
      return { conversationId: created.id }
    }

    // Dedicated mode: reuse or single-flight create one helmx-owned conversation per trigger.
    const conversationId = await resolveDedicatedConversation(
      host,
      target,
      effectiveProfileId,
      dedicatedInflight,
    )
    if (isClosing()) {
      throw new HelmxError('runtime_closing', 'the runtime is closing; new trigger deliveries are rejected', 409, {
        source: event.source,
      })
    }
    await host.dispatchTrigger({
      ...event,
      targetConversationId: conversationId,
      whenBusy: event.whenBusy ?? 'followUp',
    })
    return { conversationId }
  }
}

function assertConversationExists(host: ConversationLookup, id: number): void {
  if (!Number.isInteger(id) || id <= 0) {
    throw new HelmxError('validation_error', `targetConversationId is not a positive integer (${String(id)})`, 400, {})
  }
  try {
    host.getConversation(id)
  } catch (err) {
    if (isConversationNotFoundError(err)) {
      throw new HelmxError(
        'not_found',
        `the trigger target conversation #${id} does not exist (possibly deleted; please update the trigger target)`,
        404,
        { targetConversationId: id },
      )
    }
    throw err
  }
}

async function resolveDedicatedConversation(
  host: ConversationLookup,
  target: Extract<TriggerDeliveryTarget, { kind: 'dedicated' }>,
  profileId: string,
  inflightMap: Map<string, Promise<number>>,
): Promise<number> {
  const sourceTag = triggerSourceTag(target.triggerKind, target.triggerId)
  if (target.dedicatedConversationId !== undefined) {
    try {
      const existing = host.getConversation(target.dedicatedConversationId)
      if (
        existing.parentConversationId === undefined &&
        (existing.ownedBy ?? 'human') === 'helmx' &&
        existing.profileId === profileId &&
        existing.tags.includes(sourceTag)
      ) {
        return existing.id
      }
    } catch (err) {
      if (!isConversationNotFoundError(err)) throw err
    }
  }

  const discovered = host
    .listConversations({ tag: sourceTag, ownedBy: 'helmx', topLevelOnly: true })
    .filter(
      (c) =>
        c.parentConversationId === undefined &&
        (c.ownedBy ?? 'human') === 'helmx' &&
        c.profileId === profileId,
    )
    .sort((a, b) => a.id - b.id)
  if (discovered[0] !== undefined) {
    const id = discovered[0].id
    if (target.dedicatedConversationId !== id) {
      await target.onDedicatedConversationId?.(id)
    }
    return id
  }

  const inflight = inflightMap.get(sourceTag)
  if (inflight !== undefined) return inflight

  const creation = (async () => {
    const created = await host.createConversation({
      title: formatTriggerConversationTitle({
        triggerKind: target.triggerKind,
        triggerId: target.triggerId,
        label: target.label,
      }),
      profileId,
      tags: [TRIGGER_TAG, sourceTag],
      ownedBy: 'helmx',
    })
    if (created.ownedBy !== 'helmx') {
      host.markConversationOwnership?.(created.id, 'helmx')
    }
    await target.onDedicatedConversationId?.(created.id)
    return created.id
  })()
  inflightMap.set(sourceTag, creation)
  try {
    return await creation
  } finally {
    if (inflightMap.get(sourceTag) === creation) inflightMap.delete(sourceTag)
  }
}
