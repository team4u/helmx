/**
 * Hook bridge: maps SDK `GenerationTask` / `ToolTask` hooks to helmx's lifecycle hook pipelines.
 *
 * Extracted from `runtime.ts`. Bridges `before_turn` into `PluginHost.runHook` and enforces the single
 * outbound tool-result boundary (schema validation, redaction, and artifact spill) on `ToolTask.afterTool`.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Message } from '@earendil-works/pi-ai'
import {
  GenerationTask,
  ToolTask,
  defineExtension,
  hook,
  type Extension,
  type ToolExecutionResult,
} from '@earendil-works/pi-durable'
import type {
  BeforeTurnHookPayload,
  ConversationSummary,
  HookName,
  HookPayloadMap,
  HookResult,
  JsonSchema,
} from '@helmx/protocol'
import {
  KERNEL_TOOL_PRESENTATION_META_SCHEMAS,
  matchesConversationScope,
} from '@helmx/protocol'
import { randomUUID } from 'node:crypto'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import type { DerivedToolSpec, PluginHost } from '../plugins/index.js'
import {
  actionCliCommand,
  projectActionPromptSection,
  renderAvailableActionsSection,
  type ActionDirectoryEntry,
} from './action-prompts.js'
import {
  assertSafeMessageSurgery,
  projectToolPromptSections,
  sectionsEqual,
  systemSectionsOf,
  withSections,
  withToolDeclarations,
} from './hook-projection.js'
import { guardToolExecutionResult, type GuardToolResultOptions } from './tools/tool-result-contract.js'
import { ASK_USER_PROMPT_SNIPPET, ASK_USER_SCOPE, ASK_USER_TOOL_NAME } from './tools/ask-tools.js'
import { lookupRegistryToolSchemas, type ToolSchemaEntry } from './tool-registry.js'

const REGISTER_STRUCTURED_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { accepted: { type: 'boolean' } },
  required: ['accepted'],
}

type HookDecision =
  | { action: 'continue' }
  | { action: 'transform'; value: unknown }
  | { action: 'handled'; result?: unknown }
  | { action: 'block'; reason: string }

interface HookBridgeOptions {
  readonly registry: { install(extension: Extension): void }
  /** Lazily resolved `PluginHost` (may not exist yet during initialization). */
  readonly pluginHost: () => PluginHost | undefined
  /** Unified outbound tool-result processor (single schema/budget guard + redaction + spill boundary). */
  readonly prepareToolResult: (
    conversationId: number,
    result: ToolExecutionResult,
    options?: GuardToolResultOptions,
  ) => Promise<ToolExecutionResult>
  /** Optional explicit schema resolver (defaults to live pluginHost + registered kernel tools). */
  readonly getToolSchemas?: (toolName: string) => ToolSchemaEntry | undefined
  /** Safe conversation summary lookup (returns `undefined` if missing/corrupted -> skips `before_turn`). */
  readonly safeSummary: (conversationId: number) => ConversationSummary | undefined
  /** Current turn's input metadata (`before_turn` payload). */
  readonly currentRunInputs: (conversationId: number) => BeforeTurnHookPayload['inputs']
  readonly redact: (text: string) => string
  /** Tool artifact port (used by `prepareToolResult` host implementation). */
  readonly artifacts: {
    spill(conversationId: number, id: string, text: string): Promise<{ artifact?: unknown; text: string }>
  }
}

export class HookBridge {
  private readonly options: HookBridgeOptions

  constructor(options: HookBridgeOptions) {
    this.options = options
  }

  /** Install the SDK hook extension once during initialization. */
  install(): void {
    this.options.registry.install(
      defineExtension({
        name: 'helmx-hook-bridge',
        hooks: [
          hook(ToolTask, {
            /** All final tool outputs pass once through the redaction, schema, budget, and spill boundary before persistence. */
            afterTool: async (call, result, api) => {
              try {
                const schemas = this.resolveToolSchemas(call.name)
                return await this.options.prepareToolResult(api.conversationId, result, {
                  toolName: call.name,
                  callId: call.id,
                  structuredOutputSchema: schemas.structuredOutputSchema,
                  presentationMetaSchema: schemas.presentationMetaSchema,
                  enforceSchemas: true,
                })
              } catch (error) {
                return {
                  isError: true,
                  output: [{ type: 'text', text: this.options.redact(`tool_result_failed: ${error instanceof Error ? error.message : String(error)}`) }],
                }
              }
            },
          }),
          hook(GenerationTask, {
            /**
             * `before_turn` bridge: SDK native `sections` (`PromptSection`) and tools are already resolved during
             * prepare (`request.messages` includes the leading `pi.system` message), so `beforeRequest` receives
             * the final model messages (starting with system). Passes real `sections`/`tools`/`messages` payloads to
             * plugins, and rewrites the model request via leading system `sections` / `toolsAdded`.
             * After hooks converge, host projects `prompt.tools.*` sections (see `transformBeforeTurn`).
             */
            beforeRequest: async (request, api) => {
              const conversationId = api.conversationId
              const summary = this.options.safeSummary(conversationId)
              if (!summary) return undefined
              return this.transformBeforeTurn(request, summary, conversationId)
            },
          }),
        ],
      }) as Extension,
    )
  }

  /** Apply `before_turn` transforms across all three surfaces (`sections` / `messages` / `tools`). */
  private async transformBeforeTurn(
    request: { readonly messages: readonly Message[] },
    summary: ConversationSummary,
    conversationId: number,
  ): Promise<{ readonly messages: readonly Message[] } | undefined> {
    const host = this.options.pluginHost()
    const runtimeTools = getCurrentTools(request.messages)
    const unscopedPluginTools = host !== undefined ? host.listTools() : []
    const unscopedByName = new Map<string, DerivedToolSpec>()
    for (const spec of unscopedPluginTools) unscopedByName.set(spec.name, spec)
    const scopedPluginTools =
      host !== undefined && unscopedByName.size > 0 ? host.listTools(summary) : []
    // Scope filtering: plugin tools are registered globally on the harness (`helmx-plugins`), and `ask_user`
    // is registered globally on `helmx-core`. Strip out-of-scope declarations for this conversation before
    // entering hooks so non-eligible sessions (subagents / `helmx`-owned) never see them.
    const isAskUserAllowed = matchesConversationScope(ASK_USER_SCOPE, summary)
    const kernelScopedTools = isAskUserAllowed
      ? runtimeTools
      : runtimeTools.filter((tool) => tool.name !== ASK_USER_TOOL_NAME)
    const effectiveTools =
      unscopedByName.size > 0
        ? this.scopeLocalTools(kernelScopedTools, unscopedByName, scopedPluginTools)
        : kernelScopedTools
    const original = request.messages as unknown as Array<Record<string, unknown>>
    const payload: BeforeTurnHookPayload = {
      conversation: summary,
      inputs: this.options.currentRunInputs(conversationId),
      tools: effectiveTools.map((spec) => {
        const schemas = this.resolveToolSchemas(spec.name, unscopedByName)
        return {
          name: spec.name,
          description: spec.description,
          inputSchema: spec.parameters as Record<string, unknown>,
          ...(schemas.structuredOutputSchema !== undefined
            ? { structuredOutputSchema: schemas.structuredOutputSchema }
            : {}),
          ...(schemas.presentationMetaSchema !== undefined
            ? { presentationMetaSchema: schemas.presentationMetaSchema }
            : {}),
        }
      }) as unknown as BeforeTurnHookPayload['tools'],
      sections: systemSectionsOf(request.messages),
      messages: original,
    }
    const outcome = await this.runHookChain('before_turn', payload)
    // Host final scoped projection: regardless of whether hooks transformed, overwrite `prompt.tools.*`
    // sections according to final active tools (only active tools enter the prompt; disabled/stripped tools
    // have their sections cleared immediately, leaving no phantom prompts). Uses live PluginHost declarations.
    const activeTools = this.activeToolPrompts(scopedPluginTools, effectiveTools, outcome)
    const outcomeSections = outcome?.action === 'transform'
      ? outcome.value.sections
      : payload.sections
    const projected = projectActionPromptSection(
      projectToolPromptSections(outcomeSections, activeTools),
      this.renderActionDirectory(host, summary, effectiveTools, outcome),
    )
    const value: BeforeTurnHookPayload = outcome?.action === 'transform'
      ? { ...outcome.value, sections: projected }
      : { ...payload, sections: projected }

    // `sections` changes -> rewrite leading system message sections (SDK native mechanism).
    // `messages` changes -> full replacement (when explicitly requested by plugin). Boundary checks:
    // 1. Must be a non-empty array with a leading system message (SDK replay mechanism expects a leading system);
    // 2. Preserve original base system content (sections/tool declarations may change, but formatting rules and
    //    history body must never be overwritten by plugins — prevents inplace diff mutation corruption of system header);
    // 3. Remaining non-system history keeps strict original ordering (prefix trimming only; never fabricate/rewrite history).
    let messages = original
    const sectionsChanged = !sectionsEqual(value.sections, payload.sections)
    const messagesChanged = value.messages !== payload.messages
    if (messagesChanged) messages = assertSafeMessageSurgery(original, value.messages)
    if (sectionsChanged) messages = withSections(messages, value.sections)

    // Tool declaration rewrite baseline is SDK's originally resolved tool set (including out-of-scope plugin tools):
    // whenever the final set differs from original (due to scope trimming or hook stripping), replay via toolsRemoved/toolsAdded.
    const initialNames = new Set(runtimeTools.map((tool) => tool.name))
    const declared = new Set(value.tools.map((tool) => tool.name))
    if (declared.size !== initialNames.size || [...declared].some((name) => !initialNames.has(name))) {
      messages = withToolDeclarations(messages, declared, runtimeTools)
    }
    if (messages === original) return undefined
    return { messages: messages as unknown as readonly Message[] }
  }

  /**
   * Scope-trim plugin tools: among globally registered plugin tools (`helmx-plugins`), strip declarations whose
   * scope does not match this conversation before entering the hook chain (retaining kernel tools and matching
   * plugin tools). Runtime `assertScopeAllows` still enforces at execution; this eliminates request-level leaks.
   */
  private scopeLocalTools<T extends { name: string }>(
    requestTools: T[],
    globalByName: ReadonlyMap<string, DerivedToolSpec>,
    scopedSpecs: ReadonlyArray<DerivedToolSpec>,
  ): T[] {
    if (globalByName.size === 0) return requestTools
    const localNames = new Set(scopedSpecs.map((tool) => tool.name))
    return requestTools.filter((tool) => !globalByName.has(tool.name) || localNames.has(tool.name))
  }

  /**
   * Render `<available_actions>` catalog section: generated only when `run_action` is present in both request tools
   * and final post-hook tools (actually reachable); includes scope-matched non-`exposeAsTool` actions (`exposeAsTool`
   * actions are declared directly as tools and do not fall back to the catalog even if stripped). Returns `undefined`
   * when no actions are reachable (clearing any stale `prompt.actions` section).
   */
  private renderActionDirectory(
    host: PluginHost | undefined,
    summary: ConversationSummary,
    requestTools: Array<{ name: string }>,
    outcome: { action: string; value?: unknown } | undefined,
  ): string | undefined {
    if (host === undefined) return undefined
    const requestNames = new Set(requestTools.map((tool) => tool.name))
    const finalNames =
      outcome?.action === 'transform'
        ? new Set(
            ((outcome.value as { tools?: Array<{ name?: unknown }> }).tools ?? [])
              .filter((t) => typeof t.name === 'string')
              .map((t) => t.name as string),
          )
        : requestNames
    if (!requestNames.has('run_action') || !finalNames.has('run_action')) return undefined
    const entries: ActionDirectoryEntry[] = []
    for (const manifest of host.listActions()) {
      if (manifest.visibility === 'ui' || manifest.visibility === 'internal') continue
      if (manifest.exposeAsTool === true) continue
      if (manifest.exposeToPrompt === false) continue
      if (!matchesConversationScope(manifest.scope, summary)) continue
      entries.push({ manifest, cliCommand: actionCliCommand(manifest) })
    }
    return renderAvailableActionsSection(entries)
  }

  /**
   * Collect prompt metadata for final active tools: intersection of PluginHost's live scoped declarations and the
   * converged post-hook tool list — tools stripped by plugins (e.g. memory disabled) do not project prompt sections.
   * When hooks do not transform, all SDK-resolved request tools are permitted.
   */
  private activeToolPrompts(
    declared: ReadonlyArray<DerivedToolSpec>,
    requestTools: Array<{ name: string }>,
    outcome: { action: string; value?: unknown } | undefined,
  ): Array<{ name: string; promptSnippet?: string; promptGuidelines?: string[] }> {
    const requestNames = new Set(requestTools.map((tool) => tool.name))
    const finalNames =
      outcome?.action === 'transform'
        ? new Set(
            ((outcome.value as { tools?: Array<{ name?: unknown }> }).tools ?? [])
              .filter((t) => typeof t.name === 'string')
              .map((t) => t.name as string),
          )
        : requestNames
    const out: Array<{ name: string; promptSnippet?: string; promptGuidelines?: string[] }> = []
    for (const spec of declared) {
      if (!requestNames.has(spec.name)) continue
      if (!finalNames.has(spec.name)) continue
      if (spec.promptSnippet === undefined && spec.promptGuidelines === undefined) continue
      out.push({
        name: spec.name,
        ...(spec.promptSnippet !== undefined ? { promptSnippet: spec.promptSnippet } : {}),
        ...(spec.promptGuidelines !== undefined ? { promptGuidelines: spec.promptGuidelines } : {}),
      })
    }
    if (requestNames.has(ASK_USER_TOOL_NAME) && finalNames.has(ASK_USER_TOOL_NAME)) {
      out.push({
        name: ASK_USER_TOOL_NAME,
        promptSnippet: ASK_USER_PROMPT_SNIPPET,
      })
    }
    return out
  }

  /** Run a unified hook pipeline; converts `continue` into `undefined` so callers apply default behavior. */
  async runHookChain<K extends HookName>(
    name: K,
    payload: HookPayloadMap[K],
  ): Promise<HookResult<HookPayloadMap[K]> | undefined>
  async runHookChain(name: HookName, payload: unknown): Promise<HookDecision | undefined>
  async runHookChain<K extends HookName>(
    name: K,
    payload: HookPayloadMap[K] | unknown,
  ): Promise<HookResult<HookPayloadMap[K]> | HookDecision | undefined> {
    const host = this.options.pluginHost()
    if (!host) return undefined
    const result = await host.runHook(name, payload as HookPayloadMap[K])
    if (result.action === 'continue') return undefined
    return result
  }

  /** Resolve declared schemas for a tool from explicit resolver, live plugin tools, or registered kernel tools. */
  private resolveToolSchemas(
    toolName: string,
    preloadedPluginTools?: ReadonlyMap<string, DerivedToolSpec>,
  ): ToolSchemaEntry {
    if (this.options.getToolSchemas !== undefined) {
      return this.options.getToolSchemas(toolName) ?? {}
    }
    const host = this.options.pluginHost()
    if (host !== undefined) {
      const pluginSpec =
        preloadedPluginTools !== undefined
          ? preloadedPluginTools.get(toolName)
          : host.listTools().find((t) => t.name === toolName)
      if (pluginSpec !== undefined) {
        return {
          ...(pluginSpec.structuredOutputSchema !== undefined
            ? { structuredOutputSchema: pluginSpec.structuredOutputSchema }
            : {}),
          ...(pluginSpec.presentationMetaSchema !== undefined
            ? { presentationMetaSchema: pluginSpec.presentationMetaSchema }
            : {}),
        }
      }
    }
    const fromRegistry = lookupRegistryToolSchemas(this.options.registry, toolName)
    if (fromRegistry !== undefined) return fromRegistry
    if (toolName === 'register_structured_output') {
      return { structuredOutputSchema: REGISTER_STRUCTURED_OUTPUT_SCHEMA }
    }
    if (Object.hasOwn(KERNEL_TOOL_PRESENTATION_META_SCHEMAS, toolName)) {
      return { presentationMetaSchema: KERNEL_TOOL_PRESENTATION_META_SCHEMAS[toolName] }
    }
    return {}
  }

  /**
   * Run an `around` (continuation) hook (`agent_spawn` only): plugins wrap full execution (downstream hooks
   * and default native execution) by controlling `next`; falls through directly to `defaultRun` when no host.
   */
  runHookAround(
    name: 'agent_spawn',
    payload: import('@helmx/protocol').AgentSpawnRequest,
    defaultRun: (finalPayload: import('@helmx/protocol').AgentSpawnRequest) => Promise<unknown>,
  ): Promise<unknown> {
    const host = this.options.pluginHost()
    if (!host) return defaultRun(payload)
    return host.runHookAround(name, payload, defaultRun)
  }
}

/** Unified outbound tool-result handling: bounded presentationMeta/structuredOutput guard + redaction + spill boundary. */
export async function prepareToolResultWith(
  artifacts: HookBridgeOptions['artifacts'],
  redact: (text: string) => string,
  conversationId: number,
  result: ToolExecutionResult,
  options?: GuardToolResultOptions,
): Promise<ToolExecutionResult> {
  const safe = guardToolExecutionResult(result, redact, options)
  const output = safe.output ?? []
  const text = output.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  const spill = await artifacts.spill(conversationId, `tool-${randomUUID()}`, text)
  if (!spill.artifact) return safe
  return { ...safe, output: [{ type: 'text', text: spill.text }, ...output.filter((block) => block.type !== 'text')] }
}

export { BACKGROUND_CONTEXT }
