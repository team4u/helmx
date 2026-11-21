/**
 * Pure derivation for the builtin:swarm tool-call timeline rows (zero
 * React/DOM dependencies, Fast Refresh compliant).
 *
 * Inputs are lenient wide-object guarded (the browser never imports server
 * runtime modules): tool `input` is the JSON the model sent, `presentationMeta`
 * is the bounded, schema-validated UI projection persisted in `details`.
 * Nothing is fabricated — missing facts stay undefined and the row falls back
 * to the inline raw details view.
 */
import type { ToolViewProps } from '@helmx/protocol'
import { isPlainObject, type BoardPostKind } from './board-model.ts'

type ToolViewPropsWithPresentationMeta = ToolViewProps & {
  presentationMeta?: Readonly<Record<string, unknown>>
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}

function asTrimmedString(v: unknown, maxChars: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const trimmed = v.trim()
  if (trimmed === '') return undefined
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1)}…` : trimmed
}

/** Extract bounded presentationMeta object from ToolViewProps (never parses result JSON). */
export function extractSwarmPresentationMeta(
  props: ToolViewProps,
): Readonly<Record<string, unknown>> | undefined {
  const meta = (props as ToolViewPropsWithPresentationMeta).presentationMeta
  return isPlainObject(meta) ? meta : undefined
}

export type SwarmToolTargetKind =
  | 'create_group'
  | 'update_group'
  | 'dispatch_worker'
  | 'board_post'
  | 'board_read'
  | 'board_status'
  | 'abort_worker'
  | 'switch_worker_model'
  | 'inspect_worker'
  | 'archive_worker'
  | 'close_group'

/** Facts extracted from one swarm tool call (all optional, never fabricated). */
export interface SwarmToolFacts {
  toolName: SwarmToolTargetKind | string
  /** Group title / objective excerpts for group-level calls. */
  groupTitle?: string
  /** Target member short name when the call addresses one. */
  memberName?: string
  /** Member conversation id (from the structured result, input, or the index). */
  memberConversationId?: number
  /** Dispatch brief / post body excerpt. */
  taskExcerpt?: string
  /** Board post kind (natural verb mapping happens in copy.ts). */
  postKind?: BoardPostKind
  /** Natural target label of a board post (members/channels/coordinator/all). */
  postTargets?: string[]
  /** Switched model string. */
  model?: string
  /** Number of retained worktree branches after close. */
  retainedCount?: number
  /** Number of posts returned by a read. */
  postCount?: number
  /** Latest board seq touched by the call (auxiliary #seq info). */
  seq?: number
  /** Worker archived vs already archived. */
  archived?: boolean
  /** Abort actually stopped a running turn vs was a no-op. */
  aborted?: boolean
}

function readMemberName(
  input: Record<string, unknown>,
  meta: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  return asTrimmedString(input['name'], 32) ?? asTrimmedString(meta?.['memberName'], 32)
}

function readWorkerConversationId(
  input: Record<string, unknown>,
  meta: Readonly<Record<string, unknown>> | undefined,
): number | undefined {
  const candidates = [input['workerConversationId'], meta?.['workerConversationId']]
  for (const c of candidates) {
    if (isPosInt(c)) return c
  }
  return undefined
}

function readPostTargets(input: Record<string, unknown>): string[] | undefined {
  const raw = input['to']
  if (!Array.isArray(raw)) return undefined
  const targets = raw.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
  return targets.length > 0 ? targets.slice(0, 4) : undefined
}

/** Extract display facts for one swarm tool call (wide-object guarded, lenient). */
export function resolveSwarmToolFacts(
  toolName: string,
  input: unknown,
  meta: Readonly<Record<string, unknown>> | undefined,
): SwarmToolFacts {
  const inputRecord = isPlainObject(input) ? input : {}
  const facts: SwarmToolFacts = { toolName }

  switch (toolName) {
    case 'swarm_create_group':
    case 'swarm_update_group': {
      facts.groupTitle = asTrimmedString(inputRecord['title'], 80) ?? asTrimmedString(meta?.['groupTitle'], 80)
      break
    }
    case 'swarm_dispatch_worker': {
      facts.memberName = readMemberName(inputRecord, meta)
      facts.taskExcerpt = asTrimmedString(inputRecord['prompt'], 96)
      facts.memberConversationId = readWorkerConversationId(inputRecord, meta)
      if (isPosInt(meta?.['seq'])) facts.seq = meta['seq']
      break
    }
    case 'swarm_board_post': {
      const kind = inputRecord['kind']
      if (typeof kind === 'string') facts.postKind = kind as BoardPostKind
      else if (typeof meta?.['postKind'] === 'string') facts.postKind = meta['postKind'] as BoardPostKind
      facts.postTargets = readPostTargets(inputRecord)
      facts.taskExcerpt = asTrimmedString(inputRecord['body'], 96)
      if (isPosInt(meta?.['seq'])) facts.seq = meta['seq']
      break
    }
    case 'swarm_board_read': {
      if (isNonNegInt(meta?.['postCount'])) facts.postCount = meta['postCount']
      break
    }
    case 'swarm_board_status': {
      break
    }
    case 'swarm_abort_worker': {
      facts.memberName = readMemberName(inputRecord, meta)
      facts.memberConversationId = readWorkerConversationId(inputRecord, meta)
      if (typeof meta?.['aborted'] === 'boolean') facts.aborted = meta['aborted']
      break
    }
    case 'swarm_switch_worker_model': {
      facts.memberName = readMemberName(inputRecord, meta)
      facts.memberConversationId = readWorkerConversationId(inputRecord, meta)
      facts.model = asTrimmedString(meta?.['model'], 200) ?? asTrimmedString(inputRecord['model'], 200)
      break
    }
    case 'swarm_inspect_worker': {
      facts.memberName = readMemberName(inputRecord, meta)
      facts.memberConversationId = readWorkerConversationId(inputRecord, meta)
      break
    }
    case 'swarm_archive_worker': {
      facts.memberName = readMemberName(inputRecord, meta)
      facts.memberConversationId = readWorkerConversationId(inputRecord, meta)
      if (typeof meta?.['archived'] === 'boolean') facts.archived = meta['archived']
      break
    }
    case 'swarm_close_group': {
      if (isNonNegInt(meta?.['retainedCount'])) facts.retainedCount = meta['retainedCount']
      break
    }
    default:
      break
  }
  return facts
}

/**
 * Resolve the click target of one trace row: member rows open the
 * ConversationDrawer, group-level orchestration rows open the swarm workbench
 * panel; when no target can be derived the caller expands the raw details
 * (never a fabricated destination).
 */
export type SwarmToolClickTarget =
  | { kind: 'member'; conversationId: number }
  | { kind: 'group' }

export function resolveSwarmToolClickTarget(
  facts: SwarmToolFacts,
  options: { memberLookup?: (name: string) => number | undefined } = {},
): SwarmToolClickTarget | undefined {
  const memberTools = new Set([
    'swarm_dispatch_worker',
    'swarm_abort_worker',
    'swarm_switch_worker_model',
    'swarm_inspect_worker',
    'swarm_archive_worker',
  ])
  if (memberTools.has(facts.toolName)) {
    if (facts.memberConversationId !== undefined) return { kind: 'member', conversationId: facts.memberConversationId }
    if (facts.memberName !== undefined) {
      const resolved = options.memberLookup?.(facts.memberName)
      if (resolved !== undefined) return { kind: 'member', conversationId: resolved }
    }
    return undefined
  }
  return { kind: 'group' }
}
