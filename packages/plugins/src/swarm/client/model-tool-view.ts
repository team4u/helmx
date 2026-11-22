/**
 * Pure derivation for builtin:swarm tool-call timeline rows (Fast Refresh compliant).
 */
import type { ToolViewProps } from '@helmx/protocol'
import { isPlainObject, type BoardPostKind } from './board-model.ts'

const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

function asTrimmed(v: unknown, maxChars: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t === '' ? undefined : t.length > maxChars ? `${t.slice(0, maxChars - 1)}…` : t
}

export const extractSwarmPresentationMeta = (
  props: ToolViewProps,
): Readonly<Record<string, unknown>> | undefined => (isPlainObject(props.presentationMeta) ? props.presentationMeta : undefined)

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

export interface SwarmToolFacts {
  toolName: SwarmToolTargetKind | string
  groupTitle?: string
  memberName?: string
  memberConversationId?: number
  taskExcerpt?: string
  postKind?: BoardPostKind
  postTargets?: string[]
  model?: string
  retainedCount?: number
  postCount?: number
  seq?: number
  archived?: boolean
  aborted?: boolean
}

const MEMBER_TOOLS = new Set([
  'swarm_dispatch_worker',
  'swarm_abort_worker',
  'swarm_switch_worker_model',
  'swarm_inspect_worker',
  'swarm_archive_worker',
])

export function resolveSwarmToolFacts(
  toolName: string,
  input: unknown,
  meta: Readonly<Record<string, unknown>> | undefined,
): SwarmToolFacts {
  const inp = isPlainObject(input) ? input : {}
  const facts: SwarmToolFacts = { toolName }

  if (MEMBER_TOOLS.has(toolName)) {
    facts.memberName = asTrimmed(inp['name'], 32) ?? asTrimmed(meta?.['memberName'], 32)
    facts.memberConversationId = isPosInt(inp['workerConversationId'])
      ? inp['workerConversationId']
      : isPosInt(meta?.['workerConversationId'])
        ? meta['workerConversationId']
        : undefined
  }

  switch (toolName) {
    case 'swarm_create_group':
    case 'swarm_update_group':
      facts.groupTitle = asTrimmed(inp['title'], 80) ?? asTrimmed(meta?.['groupTitle'], 80)
      break
    case 'swarm_dispatch_worker':
      facts.taskExcerpt = asTrimmed(inp['prompt'], 96)
      if (isPosInt(meta?.['seq'])) facts.seq = meta['seq']
      break
    case 'swarm_board_post': {
      const kind = typeof inp['kind'] === 'string' ? inp['kind'] : typeof meta?.['postKind'] === 'string' ? meta['postKind'] : undefined
      if (kind !== undefined) facts.postKind = kind as BoardPostKind
      if (Array.isArray(inp['to'])) {
        const targets = inp['to'].filter((t): t is string => typeof t === 'string' && t.trim() !== '')
        if (targets.length > 0) facts.postTargets = targets.slice(0, 4)
      }
      facts.taskExcerpt = asTrimmed(inp['body'], 96)
      if (isPosInt(meta?.['seq'])) facts.seq = meta['seq']
      break
    }
    case 'swarm_board_read':
      if (isNonNegInt(meta?.['postCount'])) facts.postCount = meta['postCount']
      break
    case 'swarm_abort_worker':
      if (typeof meta?.['aborted'] === 'boolean') facts.aborted = meta['aborted']
      break
    case 'swarm_switch_worker_model':
      facts.model = asTrimmed(meta?.['model'], 200) ?? asTrimmed(inp['model'], 200)
      if (isPosInt(meta?.['seq'])) facts.seq = meta['seq']
      break
    case 'swarm_archive_worker':
      if (typeof meta?.['archived'] === 'boolean') facts.archived = meta['archived']
      break
    case 'swarm_close_group':
      if (isNonNegInt(meta?.['retainedCount'])) facts.retainedCount = meta['retainedCount']
      break
  }
  return facts
}

export type SwarmToolClickTarget = { kind: 'member'; conversationId: number } | { kind: 'group' }

export function resolveSwarmToolClickTarget(
  facts: SwarmToolFacts,
  options: { memberLookup?: (name: string) => number | undefined } = {},
): SwarmToolClickTarget | undefined {
  if (MEMBER_TOOLS.has(facts.toolName)) {
    const id = facts.memberConversationId ?? (facts.memberName ? options.memberLookup?.(facts.memberName) : undefined)
    return id !== undefined ? { kind: 'member', conversationId: id } : undefined
  }
  return { kind: 'group' }
}
