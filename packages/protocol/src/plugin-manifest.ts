/**
 * Read-only plugin extension contract projection DTOs
 * (zero `node:*`, zero `@earendil-works/pi-*`, zero live callbacks or secret values).
 */

import type { ConversationScope } from './conversation.js'
import type { LocalizedText } from './locale.js'
import type {
  ActionManifest,
  HookName,
  JsonSchema,
  PluginConfigFieldFormat,
  PluginConfigFieldType,
  PluginConfigFieldValue,
  PluginDiagnosticError,
  PluginPromptFields,
  PluginStatus,
} from './plugin-dto.js'

export interface PluginManifestAction extends ActionManifest {
  /** Provider-safe tool alias when `exposeAsTool === true` (omitted otherwise). */
  toolName?: string
}

export interface PluginManifestTool extends PluginPromptFields {
  name: string
  description: string
  inputSchema: JsonSchema
  structuredOutputSchema?: JsonSchema
  presentationMetaSchema?: JsonSchema
  replay?: 'safe' | 'unsafe'
  scope?: ConversationScope
  sourceKind: 'tool' | 'action'
  /** Fully-qualified `pluginId.actionId` when `sourceKind === 'action'`. */
  qualifiedId?: string
}

export interface PluginManifestUiItem {
  surface: string
  id: string
  spec: Record<string, unknown>
}

export type PluginManifestRouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'

export interface PluginManifestRoute {
  method: PluginManifestRouteMethod
  path: string
  public: boolean
}

export interface PluginManifestDoc {
  name: string
  kind: 'doc' | 'sessionDoc'
  public: true
  durable: boolean
}

export interface PluginManifestConfigField {
  key: string
  type: PluginConfigFieldType
  secret: boolean
  required: boolean
  enum?: Array<string | number>
  format?: PluginConfigFieldFormat
  label?: LocalizedText
  description?: LocalizedText
  /** Non-secret default value only; strictly omitted when `secret === true`. */
  default?: PluginConfigFieldValue
  minimum?: number
  maximum?: number
  integer?: boolean
}

export interface PluginManifestProvider {
  id: string
  name: string
}

export interface PluginManifestClientModule {
  module: string
  contentHash?: string
}

/**
 * Stably ordered, read-only, JSON-safe projection of a plugin's declared capabilities.
 * Never carries live handlers, runtime config values, secrets, private docs, or provider auth.
 */
export interface PluginManifestProjection {
  id: string
  name: LocalizedText
  description?: LocalizedText
  icon?: string
  version?: string
  locked: boolean
  enabled: boolean
  status: PluginStatus
  error?: PluginDiagnosticError
  dependencies: string[]
  hooks: HookName[]
  actions: PluginManifestAction[]
  tools: PluginManifestTool[]
  ui: PluginManifestUiItem[]
  routes: PluginManifestRoute[]
  /** Public document/sessionDoc descriptors only; private docs and runtime values are omitted. */
  docs: PluginManifestDoc[]
  configFields: PluginManifestConfigField[]
  providers: PluginManifestProvider[]
  services: string[]
  clientModules: PluginManifestClientModule[]
}

/** Deterministic UTF-16 code-unit string comparator (locale-independent). */
export function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
