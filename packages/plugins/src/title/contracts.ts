/** builtin:title public contracts, constants, and boundary event guards. */
import { isJsonObject } from '@helmx/protocol'

export const TITLE_PLUGIN_ID = 'builtin:title' as const
export const TITLE_ACTION_GENERATE = 'generate' as const
export const TITLE_COMMAND_ID = 'generate-title' as const
export const TITLE_COMMAND_SLASH = 'title' as const

export interface TitlePluginConfig {
  autoTitle?: boolean
  model?: string
}

export interface TitleGenerateResult {
  conversationId: number
  previousTitle: string
  title: string
  changed: boolean
}

export interface TitlePluginOptions {
  modelTimeoutMs?: number
}

const isPositiveInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0

export const asTitleDeletedConversationId = (payload: unknown): number | undefined =>
  isJsonObject(payload) && payload.type === 'conversation.deleted' && isPositiveInt(payload.conversationId)
    ? payload.conversationId
    : undefined
