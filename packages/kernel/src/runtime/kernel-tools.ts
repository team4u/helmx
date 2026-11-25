/**
 * Kernel tool factory: `run_action` meta-tool.
 *
 * `subagent` / `SubagentWorkflow` moved to the `builtin:workflow` plugin and `cleanup_worktree` to `builtin:worktree`
 * (`ctx.tool` declarations); the kernel retains only plugin-agnostic foundational meta-tools.
 */
import type { Context } from '@earendil-works/chord/context'
import { defineTool, type ToolExecutionApi, type ToolRegistration } from '@earendil-works/pi-durable'
import { bool, obj, opt, str, unsafe } from '@earendil-works/pi-schema'
import { safeResultText, type ActionManifest } from '@helmx/protocol'

/** Compact public action summary returned by `run_action({ list: true })`. */
export interface ListedPluginAction {
  actionId: string
  pluginId: string
  id: string
  description: string
  parameterSummary: string
  cli?: string
  idempotent?: true
  exposeAsTool: boolean
}

/** Host capability port for kernel tools. */
export interface KernelToolHost {
  /** Invoke a plugin action (`run_action` meta-tool). */
  invokePluginAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context: { conversationId: number; signal?: AbortSignal },
  ): Promise<unknown>
  /**
   * Read-only introspection of an action manifest (`run_action` `describe` mode): returns the full
   * `ActionManifest` (`inputSchema`/`outputSchema`) after filtering by currently enabled plugins and
   * conversation scope; never invokes the handler, validates input, or creates a `liveTask`.
   */
  describePluginAction(
    pluginId: string,
    actionId: string,
    context: { conversationId: number },
  ): Promise<ActionManifest>
  /**
   * Read-only discovery of reachable public plugin and core actions (`run_action` `list: true` mode):
   * filters active plugins and `core:*` owners by `public` visibility, conversation scope, and optional
   * `pluginId` (exact match, or namespace prefix when ending with `:`, e.g. `"core:"` / `"builtin:"`),
   * including actions with `exposeToPrompt: false`.
   */
  listPluginActions(context: { conversationId: number; pluginId?: string }): Promise<ListedPluginAction[]>
  /** Outbound text redaction (managed tokens / stash plaintexts). */
  redact(text: string): string
}

const runActionParameters = obj({
  actionId: opt(str({ description: 'Fully-qualified action ID in pluginId.actionId format (required unless list: true)' })),
  input: opt(unsafe<Record<string, unknown>>({ type: 'object', description: "Action input matching the action's inputSchema" })),
  describe: opt(
    bool({
      description: 'When true, return only the full action manifest (inputSchema/outputSchema) without executing; defaults to false (execute)',
    }),
  ),
  list: opt(
    bool({
      description: 'When true, list reachable public plugin and core actions in this conversation (including actions omitted from <available_actions>) without executing',
    }),
  ),
  pluginId: opt(
    str({
      description:
        'Optional plugin ID filter used only with list: true: exact ID (e.g. "builtin:triggers", "core:conversations") or namespace prefix ending with ":" (e.g. "core:", "builtin:")',
    }),
  ),
})

/** `run_action` meta-tool: discover (`list`), inspect (`describe`), or invoke plugin/core actions on demand. */
export function createRunActionTool(host: KernelToolHost): ToolRegistration<typeof runActionParameters> {
  return defineTool({
    name: 'run_action',
    description:
      'Invoke, inspect, or discover plugin-declared and core actions. ' +
      'Set list: true (with optional pluginId — exact ID like "builtin:triggers" or namespace prefix ending with ":" like "core:" / "builtin:") to list reachable public actions in this conversation (including actions omitted from <available_actions>) without executing. ' +
      'Set describe: true with actionId ("pluginId.actionId") to read the full action manifest (inputSchema/outputSchema) without executing. ' +
      'Otherwise pass actionId ("pluginId.actionId") and optional input to invoke the action; invalid inputs fail explicitly.',
    parameters: runActionParameters,
    async execute(args, api: ToolExecutionApi, context: Context) {
      if (args.list === true) {
        if (args.describe === true) {
          return {
            output: [{ type: 'text', text: 'run_action_failed: list: true cannot be combined with describe: true' }],
            isError: true,
          }
        }
        if (args.actionId !== undefined) {
          return {
            output: [{ type: 'text', text: 'run_action_failed: list: true cannot be combined with actionId' }],
            isError: true,
          }
        }
        if (args.input !== undefined) {
          return {
            output: [{ type: 'text', text: 'run_action_failed: list: true cannot be combined with input' }],
            isError: true,
          }
        }
        if (args.pluginId !== undefined && args.pluginId.trim() === '') {
          return {
            output: [{ type: 'text', text: 'run_action_failed: pluginId must be a non-empty string when provided' }],
            isError: true,
          }
        }
        try {
          const actions = await host.listPluginActions({
            conversationId: api.conversationId,
            ...(args.pluginId !== undefined ? { pluginId: args.pluginId } : {}),
          })
          return {
            output: [{ type: 'text', text: host.redact(JSON.stringify(actions, null, 2)) }],
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return {
            output: [{ type: 'text', text: `run_action_failed: ${message}` }],
            isError: true,
          }
        }
      }

      if (args.pluginId !== undefined) {
        return {
          output: [{ type: 'text', text: 'run_action_failed: pluginId is only valid when list: true' }],
          isError: true,
        }
      }
      const qualified = args.actionId
      if (typeof qualified !== 'string' || qualified.trim().length === 0) {
        return {
          output: [{ type: 'text', text: 'run_action_failed: missing actionId (expected pluginId.actionId, or pass list: true to discover actions)' }],
          isError: true,
        }
      }
      const dot = qualified.indexOf('.')
      if (dot <= 0 || dot === qualified.length - 1) {
        return {
          output: [{ type: 'text', text: `run_action_failed: invalid action ID (expected pluginId.actionId): ${qualified}` }],
          isError: true,
        }
      }
      const pluginId = qualified.slice(0, dot)
      const actionId = qualified.slice(dot + 1)
      try {
        if (args.describe === true) {
          const manifest = await host.describePluginAction(pluginId, actionId, {
            conversationId: api.conversationId,
          })
          return {
            output: [{ type: 'text', text: host.redact(JSON.stringify(manifest, null, 2)) }],
          }
        }
        const result = await host.invokePluginAction(pluginId, actionId, args.input ?? {}, {
          conversationId: api.conversationId,
          signal: context.abortSignal,
        })
        return {
          output: [{ type: 'text', text: safeResultText(result, (text) => host.redact(text)) }],
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          output: [{ type: 'text', text: `run_action_failed: ${message}` }],
          isError: true,
        }
      }
    },
  })
}
