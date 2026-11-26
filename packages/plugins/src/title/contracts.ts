/** builtin:title public contracts and constants. */

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
