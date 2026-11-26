/**
 * Live one-line activity snippet shared by ActiveTray and Workbench rows.
 */
import {
  DEFAULT_HELMX_LOCALE,
  resolveLocalizedText,
  type HelmxLocale,
} from '@helmx/plugin-client'
import type { AskSpec, ConversationLive, ConversationSummary } from '@helmx/protocol/browser'
import type { WorkflowNodeState, WorkflowRunSummary } from '../../contracts-types.js'
import { COPY, STATUS_COPY } from './copy.js'
import { asPlainRecord, extractCleanPreviewLine, firstLineOf, inputString, summarizeJsonPreview } from './parsers.js'
import type { ExecutionStatus } from './status-model.js'

export interface LiveSnippet {
  tag?: string
  text: string
  isError?: boolean
}

function shortenPathForCwd(pathText: string, cwd: string | undefined): string {
  if (!cwd) return pathText
  const normPath = pathText.replace(/\\/g, '/')
  const normCwd = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normCwd !== '' && normPath.startsWith(`${normCwd}/`)) {
    return normPath.slice(normCwd.length + 1)
  }
  return pathText
}

function formatLiveToolCall(
  tool: ConversationLive['tools'][number],
  cwd: string | undefined,
): string {
  const input = asPlainRecord(tool.input)
  const cmd = input !== undefined ? inputString(input, 'command') : undefined
  if (cmd !== undefined) return `${tool.toolName}: ${firstLineOf(cmd, 80)}`
  const rawPath =
    input !== undefined
      ? (inputString(input, 'path') ?? inputString(input, 'file_path') ?? inputString(input, 'Path'))
      : undefined
  if (rawPath !== undefined) return `${tool.toolName}: ${firstLineOf(shortenPathForCwd(rawPath, cwd), 80)}`
  return tool.toolName
}

export function resolveLiveSnippet(
  input: {
    status: ExecutionStatus
    summary?: ConversationSummary
    live?: ConversationLive
    pendingAsk?: AskSpec
    run?: WorkflowRunSummary
    runNode?: WorkflowNodeState
    loadError?: string
  },
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): LiveSnippet | undefined {
  if (input.loadError) {
    return { tag: resolveLocalizedText(COPY.tagError, locale), text: firstLineOf(input.loadError, 100), isError: true }
  }
  if (input.pendingAsk !== undefined) {
    const askTitle = resolveLocalizedText(input.pendingAsk.title, locale)
    const title = firstLineOf(askTitle || resolveLocalizedText(STATUS_COPY.blocked, locale), 100)
    return { tag: resolveLocalizedText(COPY.tagApproval, locale), text: title }
  }
  if (input.status === 'working' && input.live !== undefined) {
    const runningTools = (input.live.tools ?? []).filter((tool) => tool.status === 'running')
    const firstTool = runningTools[0]
    if (firstTool !== undefined) {
      const first = formatLiveToolCall(firstTool, input.summary?.cwd)
      const extra = runningTools.length > 1 ? ` +${runningTools.length - 1}` : ''
      return { tag: resolveLocalizedText(COPY.tagTool, locale), text: `${first}${extra}` }
    }
    const liveText = input.live.text ? extractCleanPreviewLine(input.live.text, 100) : ''
    if (liveText !== '') return { tag: resolveLocalizedText(COPY.tagOutput, locale), text: liveText }
    if (input.live.thinking && input.live.thinking.trim() !== '') {
      return {
        tag: resolveLocalizedText(COPY.tagThinking, locale),
        text: extractCleanPreviewLine(input.live.thinking, 100) || resolveLocalizedText(COPY.snippetThinking, locale),
      }
    }
  }
  if (input.status === 'working') {
    const doing = input.summary?.doing?.trim()
    if (doing) return { text: firstLineOf(doing, 100) }
    if (input.runNode?.phaseTitle) return { text: input.runNode.phaseTitle }
    return { text: resolveLocalizedText(COPY.snippetStarting, locale) }
  }
  if (input.status === 'error' || input.status === 'aborted') {
    const err =
      input.runNode?.error?.trim() ||
      input.run?.error?.trim() ||
      (input.runNode?.gate?.ok === false ? input.runNode.gate.output.trim() : '')
    if (err) return { tag: resolveLocalizedText(COPY.tagError, locale), text: firstLineOf(err, 100), isError: true }
    return {
      text: resolveLocalizedText(input.status === 'aborted' ? COPY.snippetAborted : COPY.snippetExecFailed, locale),
      isError: input.status === 'error',
    }
  }
  if (input.status === 'done') {
    const out = input.runNode?.output ?? input.run?.resultPreview ?? input.run?.result
    const preview = summarizeJsonPreview(out, 100)
    if (preview) return { tag: resolveLocalizedText(COPY.tagOutput, locale), text: preview }
  }
  return undefined
}
