/**
 * Leaf module of foundational plugin contract types shared between `plugin-manifest.ts`
 * and `plugin-dto.ts` so manifest projections and higher-level plugin DTOs avoid circular imports.
 */

import type { ConversationScope } from './conversation.js'
import type { ExecutionText, LocalizedText } from './locale.js'

/** JSON Schema object; validated uniformly by the host at the boundary. */
export type JsonSchema = Record<string, unknown>

export type HookName =
  | 'input'
  | 'before_turn'
  | 'agent_spawn'
  | 'turn_settled'

/** Single source of truth of backend hook mount point names (bi-directionally locked with the HookName type). */
export const PLUGIN_HOOK_NAMES = [
  'input',
  'before_turn',
  'agent_spawn',
  'turn_settled',
] as const satisfies readonly HookName[]

type _AssertAllHookNamesListed =
  Exclude<HookName, (typeof PLUGIN_HOOK_NAMES)[number]> extends never ? true : never
const _assertAllHookNamesListed: _AssertAllHookNamesListed = true
void _assertAllHookNamesListed

export interface PluginActionCliPositionalSpec {
  /** Input field name the positional argument is written to. */
  field: string
  /** Whether it is required. */
  required?: boolean
  /**
   * If this positional argument corresponds to an existing local file in the
   * CLI (or starts with ./ ../ /), its UTF-8 text is automatically read into
   * the target field (e.g. run <file.js> writes into script); otherwise the
   * positional string is written into field.
   */
  readFileInto?: string
}

export interface PluginActionCliSpec {
  /** Top-level command path; defaults to [pluginId without the builtin: prefix, actionId]. */
  command?: string[]
  /** CLI help copy; defaults to the action description. */
  description?: string
  /** true to hide from the top-level `helmx <plugin> <action>` commands. */
  hidden?: boolean
  /** Positional argument mapping list (consumes CLI positional arguments in order). */
  positional?: PluginActionCliPositionalSpec[]
  /** Overrides the CLI request default timeout (milliseconds; 0 means no timeout, for long-running actions like workflow run). */
  timeoutMs?: number
}

/**
 * Common prompt-guidance fields (ctx.tool, ctx.action and ActionManifest have
 * equal standing):
 * - when a tool is active, the snippet is projected into prompt.tools.<name>
 *   and the guidelines aggregate into prompt.tools.guidelines;
 * - when the action is reachable via run_action, the guidance enters the
 *   prompt.actions catalog; tools derived directly reuse the tool projection
 *   to avoid duplication.
 * Both fields are execution copy (see locale.ts): they are injected into model
 * prompts and must stay locale-stable — never localize them. Registration
 * boundaries require non-empty non-whitespace strings and promptGuidelines to
 * be a non-empty array. Guidance is projected only for capabilities reachable
 * from the current conversation; it is cleaned up when the plugin is disabled,
 * the scope mismatches or the tool is stripped.
 */
export interface PluginPromptFields {
  /** Full guidance paragraph for the capability; projected into the currently reachable tool or action catalog. Execution copy — keep locale-stable. */
  promptSnippet?: ExecutionText
  /** Usage guideline list; each item must be a non-empty non-whitespace string. Execution copy — keep locale-stable. */
  promptGuidelines?: Array<ExecutionText>
}

/** Closed set of HTTP methods supported by `ctx.route`. */
export type PluginRouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'

/** Closed set of supported `PluginConfigFieldSchema.type` discriminants. */
export const PLUGIN_CONFIG_FIELD_TYPES = ['string', 'number', 'boolean', 'string[]'] as const
export type PluginConfigFieldType = (typeof PLUGIN_CONFIG_FIELD_TYPES)[number]

/** Closed set of host-rendered semantic picker formats for string config fields. */
export const PLUGIN_CONFIG_FIELD_FORMATS = ['model', 'node', 'profile'] as const
export type PluginConfigFieldFormat = (typeof PLUGIN_CONFIG_FIELD_FORMATS)[number]

/** Runtime value shape accepted for a plugin config field. */
export type PluginConfigFieldValue = string | number | boolean | string[]

/** Plugin config field schema; secret: true is automatically split into credentials.json. */
export interface PluginConfigFieldSchema {
  type: PluginConfigFieldType
  /**
   * Closed set of allowed values:
   * - `string`: non-empty unique string list (value must be a member);
   * - `string[]`: non-empty unique string list (every array element must be a member);
   * - `number`: non-empty unique finite number list (respecting `integer` / `minimum` / `maximum`).
   * Disallowed on `boolean`, `secret: true`, and `format`-bound fields.
   */
  enum?: Array<string | number>
  /**
   * Optional host-rendered semantic control for string fields. Rendering rights
   * always stay with the host (no plugin-supplied form components): 'model'
   * picks from the host model catalog, 'node' from the registered compute
   * nodes, 'profile' from the host Profiles. Stored values stay plain string
   * ids; the control only changes how the host renders the field.
   */
  format?: PluginConfigFieldFormat
  /** Display copy for the config form field (resolved by the active UI locale). */
  label?: LocalizedText
  /** Display copy describing the field purpose (resolved by the active UI locale). */
  description?: LocalizedText
  default?: PluginConfigFieldValue
  secret?: boolean
  required?: boolean
  /** Boundary constraints for numeric fields; validated uniformly by the host before writing. */
  minimum?: number
  maximum?: number
  integer?: boolean
}

/** Plugin runtime status: active (enabled and healthy), disabled, failed (load or enable failure). */
export type PluginStatus = 'active' | 'disabled' | 'failed'

/** Structured diagnostics when a plugin fails to load or enable. */
export interface PluginDiagnosticError {
  code: string
  message: string
  /** Stage where the failure occurred: scan (manifest/entry parsing), load (module import/contract validation), define (definePlugin/UI validation), enable (provider mount/service start). */
  stage: 'scan' | 'load' | 'define' | 'enable'
  details?: Record<string, unknown>
}

/**
 * Action visibility tier controlling which invocation surfaces can discover and call the action:
 * - `'public'` (default): exposed on HTTP (`/api/actions`), CLI, Web UI, `run_action`, `<available_actions>`,
 *   Workflow DSL, and `ctx.host.invokeAction`.
 * - `'ui'`: UI/HTTP-facing action (e.g. composer completers, UI editors). Reachable via HTTP (`/api/actions`,
 *   Web `ctx.callAction`, `GET /api/actions` manifest for UI validation) and `ctx.host.invokeAction`; hidden
 *   from CLI top-level commands and `<available_actions>`, and rejected by `run_action` (execute & describe),
 *   Workflow DSL, and `exposeAsTool`.
 * - `'internal'`: plugin-to-plugin internal contract ONLY. Callable solely via `ctx.host.invokeAction` (with
 *   host-stamped unforgeable `callerPluginId`). Omitted from `GET /api/actions` and rejected on HTTP,
 *   `run_action`, Workflow DSL, `exposeAsTool`, and `composer.completer` UI bindings.
 */
export type PluginActionVisibility = 'public' | 'ui' | 'internal'

/** Serializable manifest of a single registered action, consumed by CLI / Web / Workflow. */
export interface ActionManifest extends PluginPromptFields {
  pluginId: string
  id: string
  /**
   * Action description — execution copy (plain string, deliberately never
   * localized): it feeds CLI help, workflow journals and machine-facing
   * surfaces, so the active UI locale must never change it.
   */
  description: ExecutionText
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  /** Action visibility tier (defaults to `'public'` when omitted). */
  visibility?: PluginActionVisibility
  exposeAsTool?: boolean
  /** Resolved provider-safe model tool name when `exposeAsTool === true` (omitted otherwise). */
  toolName?: string
  /**
   * Optional bounded UI presentation metadata schema declared when `exposeAsTool` is enabled
   * (persisted to `pi.tool-result.model[0].details` for replay; never enters model prompt).
   */
  presentationMetaSchema?: JsonSchema
  /**
   * Whether this non-tool public action is advertised in the `<available_actions>` prompt catalog (default true).
   * Public actions with dedicated CLI/HTTP paths (such as `skill_catalog`) may set `false` to save system prompt
   * tokens; UI-only and internal actions should declare `visibility: 'ui' | 'internal'` instead.
   */
  exposeToPrompt?: boolean
  /**
   * Whether this action is idempotent/read-only (default false):
   * - false: on interruption or failure the journal marks
   *   workflow_action_uncertain and refuses to auto-resume with a side-effect
   *   rerun;
   * - true: successful results are reused by prefix caching, and on
   *   interruption or failure resumeFromRunId may safely rerun from this step.
   */
  idempotent?: boolean
  cli?: PluginActionCliSpec
  scope?: ConversationScope
}
