/**
 * Pure derivation for the builtin:swarm composer activity tray (Fast Refresh compliant).
 */
import type { AskSpec, ConversationLive, ConversationSummary } from '@helmx/protocol'
import { DEFAULT_HELMX_LOCALE, resolveLocalizedText, type HelmxLocale } from '@helmx/plugin-client'
import {
  boardProgressOf,
  isMemberInFlight,
  isPlainObject,
  postDigestLine,
  sortBoardMembersForDisplay,
  type BoardMemberView,
  type BoardViewDoc,
} from './board-model.ts'
import { extractMemberTimingFields } from './model-timing.ts'
import {
  TRAY_AWAITING_APPROVAL,
  TRAY_AWAITING_HUMAN,
  TRAY_LOAD_FAILED_TAG,
  TRAY_OUTPUT_TAG,
  TRAY_THINKING_TAG,
  trayParallelToolsTag,
} from './copy.ts'

export interface SwarmTrayItem {
  key: string
  name: string
  conversationId: number
  liveState: BoardMemberView['liveState']
  isBlocked: boolean
  doing?: string
  runDurationMs?: number
  runStartedAt?: number
  pendingAskSince?: number
  pendingAskCount?: number
  turnCount?: number
  createdAt: number
}

export interface SwarmTrayFrontline {
  from: string
  to: string
  kind: string
  digest: string
  seq: number
}

export interface SwarmTraySummary {
  items: SwarmTrayItem[]
  workingCount: number
  blockedCount: number
  frontline: SwarmTrayFrontline | undefined
  groupStartedAt?: number
  doneCount: number
  activeCount: number
}

export function buildSwarmTraySummary(
  view: BoardViewDoc,
  conversations: ReadonlyArray<ConversationSummary>,
): SwarmTraySummary {
  const summaryById = new Map(conversations.map((c) => [c.id, c]))
  const items: SwarmTrayItem[] = sortBoardMembersForDisplay(view.members.filter(isMemberInFlight)).map((member) => {
    const summary = summaryById.get(member.conversationId)
    const doing = summary?.doing?.trim() || undefined
    return {
      key: member.name,
      name: member.name,
      conversationId: member.conversationId,
      liveState: member.liveState,
      isBlocked: member.liveState === 'blocked',
      ...(doing !== undefined ? { doing } : {}),
      ...extractMemberTimingFields(member, summary, view.group.status),
      createdAt: member.createdAt,
    }
  })

  const latest = view.posts[view.posts.length - 1]
  const frontline: SwarmTrayFrontline | undefined = latest
    ? {
        from: latest.from,
        to: latest.resolvedTargets[0] ?? latest.to[0] ?? '',
        kind: latest.kind,
        digest: postDigestLine(latest.body, 90),
        seq: latest.seq,
      }
    : undefined

  const progress = boardProgressOf(view.members)
  return {
    items,
    workingCount: items.filter((i) => !i.isBlocked).length,
    blockedCount: items.filter((i) => i.isBlocked).length,
    frontline,
    ...(view.group.createdAt > 0 ? { groupStartedAt: view.group.createdAt } : {}),
    doneCount: progress.done,
    activeCount: progress.total,
  }
}

const firstLineCompact = (text: string, maxChars = 100): string => {
  const first = (text.trim().split(/\r?\n/, 1)[0] ?? '').replaceAll(/\s+/g, ' ').trim()
  return first.length > maxChars ? `${first.slice(0, maxChars - 1)}…` : first
}

function lastMeaningfulLine(text: string): string | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').trim()
    if (line !== '') return line.replace(/^[#-]+\s+/, '')
  }
  return undefined
}

function formatRunningToolSnippet(toolName: string, input: unknown): string {
  if (isPlainObject(input)) {
    const detail = input['command'] ?? input['path'] ?? input['pattern'] ?? input['query'] ?? input['name'] ?? input['kind']
    if (typeof detail === 'string' && detail.trim() !== '') return `${toolName}: ${firstLineCompact(detail, 80)}`
  }
  return toolName
}

export function resolveSwarmTrayLiveSnippet(
  input: {
    isBlocked: boolean
    summary?: ConversationSummary
    live?: ConversationLive
    pendingAsk?: Pick<AskSpec, 'title' | 'description'>
    detailError?: string
    fallbackDoing?: string
  },
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string | undefined {
  if (input.detailError !== undefined) {
    return `${resolveLocalizedText(TRAY_LOAD_FAILED_TAG, locale)}: ${firstLineCompact(input.detailError)}`
  }
  if (
    input.isBlocked ||
    input.pendingAsk !== undefined ||
    (input.summary?.pendingAskCount ?? 0) > 0 ||
    input.summary?.status === 'blocked'
  ) {
    const raw =
      input.pendingAsk?.title ||
      input.pendingAsk?.description ||
      input.summary?.doing ||
      input.fallbackDoing ||
      resolveLocalizedText(TRAY_AWAITING_HUMAN, locale)
    return `${resolveLocalizedText(TRAY_AWAITING_APPROVAL, locale)}: ${firstLineCompact(raw)}`
  }

  const runningTools = (input.live?.tools ?? []).filter((t) => t.status === 'running')
  if (runningTools.length === 1) return formatRunningToolSnippet(runningTools[0]!.toolName, runningTools[0]!.input)
  if (runningTools.length > 1) {
    const names = runningTools.slice(0, 2).map((t) => formatRunningToolSnippet(t.toolName, t.input)).join(' · ')
    return `${trayParallelToolsTag(runningTools.length, locale)}: ${names}`
  }

  const liveText = input.live?.text ? lastMeaningfulLine(input.live.text) : undefined
  if (liveText) return `${resolveLocalizedText(TRAY_OUTPUT_TAG, locale)}: ${firstLineCompact(liveText)}`
  const liveThinking = input.live?.thinking ? lastMeaningfulLine(input.live.thinking) : undefined
  if (liveThinking) return `${resolveLocalizedText(TRAY_THINKING_TAG, locale)}: ${firstLineCompact(liveThinking)}`

  const doing = input.summary?.doing?.trim() || input.fallbackDoing?.trim()
  return doing ? firstLineCompact(doing) : undefined
}
