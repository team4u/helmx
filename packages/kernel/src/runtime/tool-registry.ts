/**
 * Runtime tool installer: registers and hot-swaps foundational kernel tools (`helmx-core`) and plugin-derived
 * tools (`helmx-plugins`).
 *
 * Responsibilities:
 * 1. `installKernelTools`: constructs `bash`/`read`/`write`/`edit`/`read_artifact`/`register_artifact` and the
 *    `run_action` meta-tool, wrapped uniformly via `wrapToolExecute` to enforce abort propagation;
 * 2. `installPluginTools`: converts `DerivedToolSpec` entries from `PluginHost.listTools()` into SDK tool
 *    extensions and installs them into the registry (replacing stale `helmx-plugins` tools in place), with
 *    outbound results redacted and formatted via `pluginToolResult`.
 */

import type { Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import {
  HelmxError,
  KERNEL_TOOL_PRESENTATION_META_SCHEMAS,
  matchesConversationScope,
} from '@helmx/protocol'
import type {
  ConversationSummary,
  JsonSchema,
  PluginToolAbortFallback,
} from '@helmx/protocol'
import type { DerivedToolSpec, PluginHost } from '../plugins/index.js'
import type { AskService } from './asks.js'
import { actionCliCommand, compactActionSignature } from './action-prompts.js'
import { createRunActionTool, type KernelToolHost } from './kernel-tools.js'
import { actionToolResult, pluginToolResult } from './tools/tool-result-contract.js'
import { throwIfToolAborted, type HelmxToolDeps } from './tool-deps.js'
import {
  createAskUserTool,
  createBashTool,
  createEditTool,
  createLoadSkillTool,
  createReadArtifactTool,
  createReadTool,
  createRegisterArtifactTool,
  createWriteTool,
} from './tools.js'

export type PluginHostToolTarget = Pick<PluginHost, 'invokeAction' | 'executeTool' | 'listTools' | 'listActions'>

interface RuntimeToolRegistryOptions {
  readonly registry: { install(extension: Extension): void }
  readonly toolDeps: HelmxToolDeps
  readonly getPluginHost: () => PluginHostToolTarget | undefined
  readonly isArtifactAuthorized: (conversationId: number, artifactConversationId: number) => boolean
  readonly redact: (text: string) => string
  /** Conversation summary lookup (used for `run_action` `describe` scope checks and `ask_user` scoping). */
  readonly getConversation: (conversationId: number) => ConversationSummary
  /** AskService port for the built-in `ask_user` tool (optional in unit tests that do not exercise `ask_user`). */
  readonly asks?: Pick<AskService, 'createAsk' | 'cancelAsk'>
}

type PluginToolApi = Pick<ToolExecutionApi, 'conversationId'> & {
  callId?: string
  output?: (chunk: string) => void
}

/** Kernel/plugin tool execution wrapper: ensures aborted calls always rethrow instead of returning masked errors. */
export function wrapToolExecute<
  TArgs,
  TApi extends { callId?: string },
  TContext extends { abortSignal?: AbortSignal },
  TResult,
>(
  execute: (args: TArgs, api: TApi, context: TContext) => Promise<TResult>,
): (args: TArgs, api: TApi, context: TContext) => Promise<TResult> {
  return async (args, api, context) => {
    const result = await execute(args, api, context)
    // If a tool implementation swallowed or converted an abort (e.g. returned `{ isError: true }`), rethrow
    // uniformly here so pi-durable `ToolTask` enters its interrupted / `writeAtClose()` revert-to-pending branch.
    throwIfToolAborted(context?.abortSignal)
    return result
  }
}

/**
 * Uniformly wrap typed tool registrations and erase contravariant type params at the heterogeneous
 * `Extension.tools` array boundary.
 */
function wrapToolRegistration<TParameters extends object, TDetails extends JsonValue>(
  tool: ToolRegistration<TParameters, TDetails>,
): ToolRegistration {
  const execute = wrapToolExecute(tool.execute.bind(tool))
  return {
    ...tool,
    execute,
  } as unknown as ToolRegistration
}

export interface ToolSchemaEntry {
  readonly structuredOutputSchema?: JsonSchema
  readonly presentationMetaSchema?: JsonSchema
}

interface RegistryToolSchemaMaps {
  readonly kernel: Map<string, ToolSchemaEntry>
  readonly plugin: Map<string, ToolSchemaEntry>
}

const registryToolSchemas = new WeakMap<object, RegistryToolSchemaMaps>()

interface RegisteredAbortFallback {
  readonly toolName: string
  readonly fallback: PluginToolAbortFallback
}

const registryAbortFallbacks = new WeakMap<object, Map<string, RegisteredAbortFallback>>()

function abortFallbackKey(conversationId: number, callId: string): string {
  return `${conversationId}\u0000${callId}`
}

/**
 * Consume and remove a registered tool abort fallback (called from `HookBridge.afterTool` when
 * `ToolTask.abort` settles an aborted tool call; never consumed during graceful `writeAtClose`).
 */
export function consumeRegistryToolAbortFallback(
  registry: object,
  conversationId: number,
  callId: string,
  toolName: string,
): PluginToolAbortFallback | undefined {
  const map = registryAbortFallbacks.get(registry)
  if (!map) return undefined
  const key = abortFallbackKey(conversationId, callId)
  const entry = map.get(key)
  if (!entry || entry.toolName !== toolName) return undefined
  map.delete(key)
  return entry.fallback
}

/** Clear all staged abort fallbacks associated with a SDK registry (called on runtime close). */
export function clearRegistryToolAbortFallbacks(registry: object): void {
  registryAbortFallbacks.get(registry)?.clear()
}

/** Lookup registered kernel/plugin tool schemas attached to a shared SDK registry instance. */
export function lookupRegistryToolSchemas(registry: object, toolName: string): ToolSchemaEntry | undefined {
  const maps = registryToolSchemas.get(registry)
  if (!maps) return undefined
  return maps.plugin.get(toolName) ?? maps.kernel.get(toolName)
}

export class RuntimeToolRegistry {
  private readonly kernelToolSchemas = new Map<string, ToolSchemaEntry>()
  private readonly pluginToolSchemas = new Map<string, ToolSchemaEntry>()

  constructor(private readonly options: RuntimeToolRegistryOptions) {
    registryToolSchemas.set(options.registry, {
      kernel: this.kernelToolSchemas,
      plugin: this.pluginToolSchemas,
    })
    if (!registryAbortFallbacks.has(options.registry)) {
      registryAbortFallbacks.set(options.registry, new Map())
    }
  }

  /** Lookup declared schemas for an installed kernel or plugin tool by name. */
  getToolSchemas(toolName: string): ToolSchemaEntry | undefined {
    return this.pluginToolSchemas.get(toolName) ?? this.kernelToolSchemas.get(toolName)
  }

  /**
   * Install foundational kernel tools (`bash`/`read`/`write`/`edit`/`read_artifact`/`register_artifact` +
   * `run_action` meta-tool) under `helmx-core` (sharing the same registry and `wrapToolExecute` takeover path as
   * plugins). `subagent` / `SubagentWorkflow` are provided by `builtin:workflow`; `cleanup_worktree` by `builtin:worktree`.
   */
  installKernelTools(): void {
    const { registry, toolDeps, getPluginHost, isArtifactAuthorized, redact, getConversation } = this.options
    const toolHost: KernelToolHost = {
      invokePluginAction: async (
        pluginId: string,
        actionId: string,
        input: unknown,
        context: { conversationId: number; signal?: AbortSignal },
      ) => {
        const host = getPluginHost()
        if (!host) throw new HelmxError('runtime_not_initialized', 'plugin host not initialized', 503)
        return host.invokeAction(pluginId, actionId, input, context, { surface: 'run_action' })
      },
      describePluginAction: async (
        pluginId: string,
        actionId: string,
        context: { conversationId: number },
      ) => {
        const host = getPluginHost()
        if (!host) throw new HelmxError('runtime_not_initialized', 'plugin host not initialized', 503)
        // Read-only manifest query: never calls `invokeAction` (never executes handler, validates input, or
        // creates a `liveTask`); enablement filtering already comes from `listActions(activeEnabledPluginIds)`.
        const manifest = host
          .listActions()
          .find((item) => item.pluginId === pluginId && item.id === actionId)
        if (manifest === undefined) {
          throw new HelmxError(
            'unknown_action',
            `Plugin '${pluginId}' does not declare action '${actionId}' (or is disabled)`,
            404,
            { pluginId, actionId },
          )
        }
        if (manifest.visibility === 'ui' || manifest.visibility === 'internal') {
          throw new HelmxError(
            'action_visibility_forbidden',
            `Action '${pluginId}.${actionId}' has visibility '${manifest.visibility}' and cannot be inspected via run_action`,
            403,
            { pluginId, actionId, visibility: manifest.visibility },
          )
        }
        // Do not leak schemas to out-of-scope conversations: reject with the exact same code as execution.
        if (!matchesConversationScope(manifest.scope, getConversation(context.conversationId))) {
          throw new HelmxError(
            'conversation_scope_violation',
            `Action '${pluginId}.${actionId}' cannot be queried in conversation ${context.conversationId} (outside allowed scope)`,
            403,
            { pluginId, actionId, conversationId: context.conversationId },
          )
        }
        return manifest
      },
      listPluginActions: async (context: { conversationId: number; pluginId?: string }) => {
        const host = getPluginHost()
        if (!host) throw new HelmxError('runtime_not_initialized', 'plugin host not initialized', 503)
        const conversation = getConversation(context.conversationId)
        const filterPluginId = context.pluginId
        const isPrefixFilter = filterPluginId !== undefined && filterPluginId.endsWith(':')
        return host
          .listActions()
          .filter((manifest) => {
            if (manifest.visibility === 'ui' || manifest.visibility === 'internal') return false
            if (filterPluginId !== undefined) {
              const matched = isPrefixFilter
                ? manifest.pluginId.startsWith(filterPluginId)
                : manifest.pluginId === filterPluginId
              if (!matched) return false
            }
            return matchesConversationScope(manifest.scope, conversation)
          })
          .sort((a, b) =>
            a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
          )
          .map((m) => {
            const cli = actionCliCommand(m)
            return {
              actionId: `${m.pluginId}.${m.id}`,
              pluginId: m.pluginId,
              id: m.id,
              description: m.description,
              parameterSummary: compactActionSignature(m.inputSchema),
              ...(cli !== undefined ? { cli } : {}),
              ...(m.idempotent ? { idempotent: true as const } : {}),
              exposeAsTool: m.exposeAsTool === true,
            }
          })
      },
      redact: (text: string) => redact(text),
    }
    const kernelTools: ToolRegistration[] = [
      wrapToolRegistration(createBashTool(toolDeps)),
      wrapToolRegistration(createReadTool(toolDeps)),
      wrapToolRegistration(createWriteTool(toolDeps)),
      wrapToolRegistration(createEditTool(toolDeps)),
      wrapToolRegistration(
        createReadArtifactTool(toolDeps, (convId: number, artifactConvId: number) =>
          isArtifactAuthorized(convId, artifactConvId),
        ),
      ),
      wrapToolRegistration(createRegisterArtifactTool(toolDeps)),
      wrapToolRegistration(createRunActionTool(toolHost)),
      wrapToolRegistration(
        createAskUserTool({
          asks: this.options.asks,
          getConversation,
          redact,
        }),
      ),
      wrapToolRegistration(createLoadSkillTool(toolDeps)),
    ]
    this.kernelToolSchemas.clear()
    for (const tool of kernelTools) {
      const structuredOutputSchema = (tool as { structuredOutputSchema?: JsonSchema }).structuredOutputSchema
      const presentationMetaSchema = Object.hasOwn(KERNEL_TOOL_PRESENTATION_META_SCHEMAS, tool.name)
        ? KERNEL_TOOL_PRESENTATION_META_SCHEMAS[tool.name]
        : undefined
      this.kernelToolSchemas.set(tool.name, {
        ...(structuredOutputSchema !== undefined ? { structuredOutputSchema } : {}),
        ...(presentationMetaSchema !== undefined ? { presentationMetaSchema } : {}),
      })
    }
    registry.install(defineExtension({ name: 'helmx-core', tools: kernelTools }))
  }

  /**
   * Build and install the `helmx-plugins` extension from plugin `DerivedToolSpec` declarations.
   * Re-installing under the same extension name replaces tools in place; an empty array clears stale tools.
   * Partial `onUpdate` payloads stream to live tool cards via native `api.output`; text is redacted uniformly,
   * and post-settlement calls are silently ignored per SDK contract.
   */
  installPluginTools(specs: DerivedToolSpec[]): void {
    const { registry, getPluginHost, redact } = this.options
    const host = getPluginHost()
    if (!host) return
    this.pluginToolSchemas.clear()
    for (const spec of specs) {
      this.pluginToolSchemas.set(spec.name, {
        ...(spec.structuredOutputSchema !== undefined ? { structuredOutputSchema: spec.structuredOutputSchema } : {}),
        ...(spec.presentationMetaSchema !== undefined ? { presentationMetaSchema: spec.presentationMetaSchema } : {}),
      })
    }
    const tools: ToolRegistration[] = specs.map((spec) => {
      const parameters = (spec.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>
      const raw = defineTool({
        name: spec.name,
        description: spec.description,
        parameters,
        ...(spec.structuredOutputSchema !== undefined
          ? { structuredOutputSchema: spec.structuredOutputSchema }
          : {}),
        ...(spec.replay !== undefined ? { replay: spec.replay } : {}),
        async execute(args: unknown, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
          const toolApi: PluginToolApi = api
          const callId = typeof toolApi.callId === 'string' && toolApi.callId !== '' ? toolApi.callId : undefined
          const fallbackKey =
            callId !== undefined ? abortFallbackKey(toolApi.conversationId, callId) : undefined
          const abortFallbacks =
            fallbackKey !== undefined ? registryAbortFallbacks.get(registry) : undefined
          try {
            const result = await host.executeTool(spec.name, args, {
              conversationId: toolApi.conversationId,
              ...(callId !== undefined ? { callId } : {}),
              signal: context.abortSignal,
              ...(fallbackKey !== undefined && abortFallbacks !== undefined
                ? {
                    setAbortFallback: (fallback) => {
                      if (fallback === undefined) {
                        abortFallbacks.delete(fallbackKey)
                      } else {
                        abortFallbacks.set(fallbackKey, { toolName: spec.name, fallback })
                      }
                    },
                  }
                : {}),
              ...(typeof toolApi.output === 'function'
                ? {
                    onUpdate: (partial) => {
                      // SDK contract: `output()` throws after settlement (`Tool call has settled`) — silently
                      // drop only that late-update case; propagate other errors (e.g. host faults) to plugin authors
                      // rather than faking success. Redaction runs on full concatenated partial text (so secrets split
                      // across chunks still match; synchronous `redact` snapshots current secrets and does not promise
                      // eliminating all in-process leaks).
                      const text = typeof partial.output === 'string'
                        ? partial.output
                        : partial.output.map((block) => block.text).join('')
                      try {
                        toolApi.output!(redact(text))
                      } catch (err) {
                        if (err instanceof Error && err.message.includes('has settled')) return
                        throw err
                      }
                    },
                  }
                : {}),
            })
            if (spec.sourceKind === 'action') {
              return actionToolResult(result, args, (text) => redact(text), {
                structuredOutputSchema: spec.structuredOutputSchema,
                presentationMetaSchema: spec.presentationMetaSchema,
                projectPresentationMeta: spec.projectPresentationMeta,
                formatOutput: spec.formatOutput,
                toolName: spec.name,
                ...(callId !== undefined ? { callId } : {}),
              }) as ToolExecutionResult
            }
            // Wrap plugin `ctx.tool` return value into the SDK `ToolExecutionResult` contract.
            return pluginToolResult(result, (text) => redact(text), {
              structuredOutputSchema: spec.structuredOutputSchema,
              presentationMetaSchema: spec.presentationMetaSchema,
              toolName: spec.name,
              ...(callId !== undefined ? { callId } : {}),
            }) as ToolExecutionResult
          } finally {
            // Retain staged abort fallback only when the call actually aborted so ToolTask.abort -> afterTool
            // can merge it atomically; normal completion and non-abort failures clear immediately.
            if (fallbackKey !== undefined && abortFallbacks !== undefined && !context.abortSignal?.aborted) {
              abortFallbacks.delete(fallbackKey)
            }
          }
        },
      })
      return wrapToolRegistration(raw)
    })
    registry.install(defineExtension({ name: 'helmx-plugins', tools }))
  }

  /** Hot-update plugin tool set after plugins enable/disable (called from app assembly and lifecycle handlers). */
  refreshPluginTools(): void {
    const host = this.options.getPluginHost()
    if (!host) return
    this.installPluginTools(host.listTools())
  }
}
