/**
 * RuntimeAgentSpawn: subagent spawning, verification Gate, and active execution facts (extracted from `KernelRuntime`).
 *
 * Responsibilities:
 * - `spawnAgent` pipeline (schema precompile check -> resume mutex guard -> around hook -> gate check -> schema verify);
 * - Native subagent environment setup and initial child conversation broadcast (0ms alignment of `parentConversationId`/`parentToolCallId`);
 * - `runGate` command execution on target nodes (remote runs for remote conversations);
 * - `buildSpawnEnv` managed child process environment construction;
 * - `resolveSpawnTarget` unified spawn target resolution (shared authoritative chain in `spawn-target.ts`);
 * - Maintaining `activeSpawnExecutions` live execution state and `agentSessions` alias mappings.
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentExecutionInfo,
  AgentSpawnRequest,
  ConversationPatch,
  ConversationSummary,
} from '@helmx/protocol'
import { HelmxError, isValidNodeId, NODE_ID_PATTERN } from '@helmx/protocol'
import type { Harness, Registry } from '@earendil-works/pi-durable'
import type { EnvFabric } from '../env/index.js'
import { assertSchemaCompilable } from '../plugins/schema.js'
import type { ConversationService } from './conversation-service.js'
import type { ConversationTracker } from './conversations.js'
import type { EventHub } from './events.js'
import type { HookBridge } from './hook-bridge.js'
import type { ModelRegistry } from './model-registry.js'
import { resolveDefaultModelRef } from './models.js'
import type { ResolvedAttachmentItem } from './conversation-attachments.js'
import { normalizeSessionCwd, resolveTargetPlatform, trustedPlatformFromEnvFabric } from './target-cwd.js'
import {
  assertSpawnForkFields,
  resolveCleanForkAnchor,
  resolveForkMode,
  resolveInheritedModelOverride,
} from './spawn-fork.js'
import { assertSpawnRequestModes } from './spawn-reattach.js'
import { resolveSpawnTargetChain, resolveSpawnTargetNodeId } from './spawn-target.js'
import {
  agentGateResultMissingError,
  sanitizeAgentExecutionInfo,
  sanitizeAgentGateResult,
  sanitizeAgentNamespacedMeta,
} from '@helmx/protocol'
import {
  assertSpawnRequestTitle,
  isSpawnConversationInTurn,
  normalizeSpawnTitle,
  runNativeSpawn,
  type NativeSpawnDeps,
  type ResolvedProfile,
} from './spawn.js'
import { cwdScopeViolationText } from './tools/cwd-scope.js'
import { validateJsonSchema, type StructuredOutputSession } from './structured-output.js'
import type { HelmxStore } from './store.js'
import type { HelmxToolDeps } from './tool-deps.js'
import { runGate } from './tools.js'
import type { Profile, SecretStash } from '../services/index.js'

/** Trim a raw `Profile` down to the core fields consumed by native spawn execution. */
function toResolvedProfile(profile: Profile): ResolvedProfile {
  return {
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel } : {}),
    ...(profile.cwd !== undefined ? { cwd: profile.cwd } : {}),
    ...(profile.nodeId !== undefined ? { nodeId: profile.nodeId } : {}),
  }
}

interface RuntimeAgentSpawnDeps {
  readonly store: HelmxStore
  readonly toolDeps: HelmxToolDeps
  readonly harness: Harness
  readonly registry: Registry
  readonly tracker: ConversationTracker
  readonly conversations: ConversationService
  readonly events: EventHub
  readonly envFabric: EnvFabric
  readonly models: ModelRegistry
  readonly hookBridge: HookBridge
  readonly stashService: SecretStash
  readonly assertWritable?: () => void
  updateConversation(id: number, patch: ConversationPatch): Promise<ConversationSummary>
}

export class RuntimeAgentSpawn {
  /** Currently active `spawnAgent` executions in flight: token -> `AgentExecutionInfo`. */
  readonly activeSpawnExecutions = new Map<string, AgentExecutionInfo>()

  /** Native spawn session alias map: `sessionId` -> `childConversationId`. */
  readonly agentSessions = new Map<string, number>()
  /** Shared structured-output result slots across this Harness (`conversationId -> session`):
   * when concurrent spawns replace same-named extensions in place on the registry, older extension closures still
   * dynamically locate their own result slot by `conversationId` in this shared map (identical semantics to a
   * module-level `WeakMap<Harness, Map>`, now injected explicitly). */
  readonly structuredOutputSessions = new Map<number, StructuredOutputSession>()

  constructor(private readonly deps: RuntimeAgentSpawnDeps) {}

  /**
   * Subagent spawning: `agent_spawn` around pipeline (continuation) -> default native subagent.
   * Kernel has zero Git/worktree semantics: isolation and execution environment policies are handled by plugins
   * via `next(finalReq)`; kernel enforces common guarantees only (meta envelope / schema / gate reporting /
   * result verification; namespaced business fields inside `meta` are validated by each plugin).
   */
  async spawnAgent(request: AgentSpawnRequest): Promise<unknown> {
    this.deps.assertWritable?.()
    if (request.schema !== undefined) assertSchemaCompilable(request.schema)
    // Envelope boundary (synchronous, before hook chains and awaits): `meta` must be a JSON-safe
    // namespaced object; kernel does not validate business contents (each plugin boundary handles its own).
    sanitizeAgentNamespacedMeta(request.meta, {
      agentId: request.agentId ?? 'subagent',
      field: 'spawn request meta',
    })
    assertSpawnRequestModes(request)
    assertSpawnRequestTitle(request.title)
    await this.assertSpawnCwdScope(request)
    const preResolvedForkAnchor = await this.preflightForkRequest(request)
    const token = randomUUID()
    try {
      if (request.resume !== undefined) {
        const resumeId = /^\d+$/.test(request.resume) ? Number(request.resume) : this.agentSessions.get(request.resume)
        const child = resumeId !== undefined ? this.deps.store.getConv(resumeId) : undefined
        if (resumeId !== undefined && child !== undefined && child.parentConversationId === request.parentConversationId) {
          // Early mutual-exclusion guard before the hook chain.
          if (
            isSpawnConversationInTurn(this.deps.harness, resumeId) ||
            [...this.activeSpawnExecutions.values()].some((info) => info.conversationId === resumeId)
          ) {
            throw new HelmxError('subagent_in_use', `Child conversation ${resumeId} already has an execution in flight; concurrent resume is not allowed`, 409)
          }
          this.activeSpawnExecutions.set(token, { conversationId: resumeId, nodeId: child.nodeId ?? 'local', effectiveCwd: child.cwd })
        }
      } else if (request.reattach !== undefined) {
        const reattachConvId = request.reattach.conversationId
        const child = this.deps.store.getConv(reattachConvId)
        if (child === undefined || child.parentConversationId !== request.parentConversationId) {
          throw new HelmxError(
            'not_found',
            `Reattach target child conversation ${reattachConvId} does not exist or does not belong to parent conversation ${request.parentConversationId}; refusing to create a new conversation instead`,
            404,
            { conversationId: reattachConvId, parentConversationId: request.parentConversationId },
          )
        }
        if (
          isSpawnConversationInTurn(this.deps.harness, reattachConvId) ||
          [...this.activeSpawnExecutions.values()].some((info) => info.conversationId === reattachConvId)
        ) {
          throw new HelmxError('subagent_in_use', `Child conversation ${reattachConvId} still has an active reattach or execution in flight; concurrent reattach is not allowed`, 409, {
            conversationId: reattachConvId,
          })
        }
        this.activeSpawnExecutions.set(token, {
          conversationId: reattachConvId,
          nodeId: child.nodeId ?? 'local',
          effectiveCwd: request.reattach.effectiveCwd ?? child.cwd,
        })
      }
      const originalResolved = request.onResolved
      let execution: AgentExecutionInfo | undefined
      let gate: ReturnType<typeof sanitizeAgentGateResult> | undefined
      const observed: AgentSpawnRequest = {
        ...request,
        onResolved: (raw) => {
          const info = sanitizeAgentExecutionInfo(raw, { agentId: request.agentId ?? 'subagent' })
          info.nodeId ??= info.conversationId !== undefined ? this.deps.store.getConv(info.conversationId)?.nodeId : undefined
          execution = info
          this.activeSpawnExecutions.set(token, info)
          originalResolved?.(info)
        },
        onGateResult: (raw) => {
          gate = sanitizeAgentGateResult(raw, { agentId: request.agentId ?? 'subagent' })
          request.onGateResult?.(gate)
        },
      }
      const result = await this.spawnAgentObserved(observed, preResolvedForkAnchor)
      if (request.schema !== undefined) {
        // Final cross-plugin boundary validation: native execution's internal validation can be bypassed when a
        // plugin takes over (`handled`) or rewrites output via hooks, so final outputs are always re-checked here.
        const validation = validateJsonSchema(result, request.schema)
        if (!validation.ok) {
          throw new HelmxError('schema_validation_failed', `Subagent final output does not match schema: ${validation.errors.join('; ')}`, 502)
        }
      }
      if (request.gate !== undefined && execution?.executionId !== undefined && gate === undefined) {
        throw agentGateResultMissingError({ agentId: request.agentId ?? 'subagent', executionId: execution.executionId, command: request.gate })
      }
      if (gate !== undefined && !gate.ok) {
        throw new HelmxError('gate_failed', `Subagent verification command failed: ${gate.output}`, 502)
      }
      return result
    } finally {
      this.activeSpawnExecutions.delete(token)
    }
  }

  /** Purge session aliases and structured-output slots bound to a deleted child conversation. */
  deleteConversationSessions(conversationId: number): void {
    for (const [sessionId, convId] of [...this.agentSessions.entries()]) {
      if (convId === conversationId) this.agentSessions.delete(sessionId)
    }
    this.structuredOutputSessions.delete(conversationId)
  }

  /**
   * Shared `Profile.restrictToCwd` boundary guard used by both `assertSpawnCwdScope` (at `spawnAgent`
   * entry before hooks) and `resolveSpawnTarget` (ensuring remote `profile.nodeId`, explicit `requestNodeId`,
   * and explicit `requestCwd` are enforced consistently across both entrypoints).
   */
  private assertParentCwdScopeViolations(options: {
    parentConversationId: number
    parentNodeId?: string
    parentCwd?: string
    profileNodeId?: string
    forkSameProfile: boolean
    requestNodeId?: string
    requestCwd?: string
    nodeLabel: 'requested' | 'resolved'
  }): void {
    const parentNodeId = options.parentNodeId ?? 'local'
    const effectiveNodeId = resolveSpawnTargetNodeId(
      options.profileNodeId,
      options.parentNodeId,
      options.forkSameProfile,
      options.requestNodeId,
    )
    if (effectiveNodeId !== parentNodeId) {
      const noun = options.nodeLabel === 'resolved' && options.requestNodeId === undefined
        ? `resolved spawn target node '${effectiveNodeId}'`
        : options.requestNodeId !== undefined
          ? `requested nodeId '${effectiveNodeId}'`
          : `profile target node '${effectiveNodeId}'`
      throw new HelmxError(
        'path_outside_workspace',
        `path_outside_workspace: ${noun} differs from parent conversation node '${parentNodeId}'; ` +
          'this conversation is restricted to its working directory (Profile.restrictToCwd)',
        403,
        {
          parentConversationId: options.parentConversationId,
          parentNodeId,
          ...(options.requestNodeId !== undefined
            ? { requestedNodeId: options.requestNodeId }
            : {}),
          ...(options.nodeLabel === 'resolved'
            ? { resolvedNodeId: effectiveNodeId }
            : {}),
        },
      )
    }
    if (options.requestCwd !== undefined && options.parentCwd !== undefined) {
      const parentPlatform = resolveTargetPlatform(
        parentNodeId,
        trustedPlatformFromEnvFabric(this.deps.envFabric),
      )
      const violation = cwdScopeViolationText(options.requestCwd, options.parentCwd, parentPlatform)
      if (violation !== undefined) {
        throw new HelmxError('path_outside_workspace', violation, 403, {
          parentConversationId: options.parentConversationId,
          requestedCwd: options.requestCwd,
          parentCwd: options.parentCwd,
        })
      }
    }
  }

  /**
   * `Profile.restrictToCwd` guardrail at the spawn entry: when the parent conversation's Profile restricts
   * to its cwd, both explicit `request.nodeId` / remote `profile.nodeId` and explicit `request.cwd` must stay
   * within the parent's node and working directory before `agent_spawn` hooks execute.
   */
  private async assertSpawnCwdScope(request: AgentSpawnRequest): Promise<void> {
    if (
      this.deps.toolDeps.restrictToCwdOf === undefined ||
      ((request.reattach !== undefined || request.resume !== undefined) &&
        request.cwd === undefined &&
        request.nodeId === undefined)
    ) {
      return
    }
    const parent = this.deps.store.getConv(request.parentConversationId)
    if (parent === undefined) return // missing parents reject later in the pipeline with their own explicit errors
    if (!(await this.deps.toolDeps.restrictToCwdOf(request.parentConversationId))) return
    const { profileId, forkSameProfile } = resolveForkMode(request.agentType, request.fork, parent.profileId)
    const profile =
      request.reattach === undefined &&
      request.resume === undefined &&
      request.nodeId === undefined &&
      !profileId.includes(':') &&
      typeof this.deps.conversations?.readProfile === 'function'
        ? await this.deps.conversations.readProfile(profileId)
        : undefined
    this.assertParentCwdScopeViolations({
      parentConversationId: request.parentConversationId,
      parentNodeId: parent.nodeId,
      parentCwd: parent.cwd,
      profileNodeId: profile?.nodeId,
      forkSameProfile,
      requestNodeId: request.nodeId,
      requestCwd: request.cwd,
      nodeLabel: 'requested',
    })
  }

  /** Fork request pre-validation and anchor locking (shared by entry preflight and final post-hook check). */
  private async preflightForkRequest(request: AgentSpawnRequest): Promise<number | undefined> {    assertSpawnForkFields(request)
    if (request.fork !== true) return undefined
    if ((request.agentType ?? '').includes(':')) {
      throw new HelmxError(
        'unsupported_runtime',
        `fork is only supported for native Profile sub-conversations; unsupported external runtime '${request.agentType}'`,
        400,
        { agentType: request.agentType },
      )
    }
    const parentMeta = this.deps.store.getConv(request.parentConversationId)
    if (parentMeta === undefined) {
      throw new HelmxError(
        'not_found',
        `Parent conversation ${request.parentConversationId} not found; cannot fork`,
        404,
        { parentConversationId: request.parentConversationId },
      )
    }
    const { profileId: effectiveProfileId } = resolveForkMode(request.agentType, true, parentMeta.profileId)
    const profile = await this.deps.conversations.readProfile(effectiveProfileId)
    if (profile === undefined) {
      throw new HelmxError(
        'not_found',
        `agentType '${effectiveProfileId}' is not a registered Profile (profiles/${effectiveProfileId} not found)`,
        404,
        { agentType: effectiveProfileId },
      )
    }
    return resolveCleanForkAnchor(this.deps.harness, request.parentConversationId)
  }

  async spawnAgentObserved(request: AgentSpawnRequest, preResolvedForkAnchor?: number): Promise<unknown> {
    // Attachment gate before entering the hook chain: both `agent_spawn` hooks and native execution are governed
    // by the same authorization guard (artifact existence + parent conversation chain ownership); re-checked if hooks rewrite.
    if (request.attachments !== undefined && request.attachments.length > 0) {
      await this.deps.conversations.resolveAuthorizedAttachments(request.parentConversationId, request.attachments)
    }
    // Around (continuation) pipeline: plugins wrap the full lifecycle (allocating resources before `next()`,
    // converging after `next()`), or take over with `handled`; falls back to native execution when unhandled.
    return this.deps.hookBridge.runHookAround('agent_spawn', request, async (finalRequest) => {
      // Envelope boundary (final around request): re-verify `meta` and fork parameters after hook transforms/continuations
      // before entering native execution so hooks cannot flip `fork` on, swap targets, or bypass preflight checks.
      sanitizeAgentNamespacedMeta(finalRequest.meta, {
        agentId: finalRequest.agentId ?? request.agentId ?? 'subagent',
        field: 'spawn request meta',
      })
      assertSpawnRequestModes(finalRequest)
      assertSpawnRequestTitle(finalRequest.title)
      const forkChanged =
        request.fork !== true ||
        finalRequest.agentType !== request.agentType ||
        finalRequest.parentConversationId !== request.parentConversationId ||
        finalRequest.resume !== undefined
      let resolvedAnchor =
        !forkChanged && preResolvedForkAnchor !== undefined
          ? preResolvedForkAnchor
          : undefined
      if (finalRequest.fork === true && (forkChanged || preResolvedForkAnchor === undefined)) {
        resolvedAnchor = await this.preflightForkRequest(finalRequest)
      }
      const resolvedAttachments =
        finalRequest.attachments !== undefined && finalRequest.attachments.length > 0
          ? await this.deps.conversations.resolveAuthorizedAttachments(finalRequest.parentConversationId, finalRequest.attachments)
          : undefined

      return runNativeSpawn(
        this.buildNativeSpawnDeps(finalRequest, resolvedAttachments, resolvedAnchor),
        finalRequest,
      )
    })
  }

  /** Compose `NativeSpawnDeps` directly from runtime dependencies (eliminates pass-through `spawn-host.ts` adapter). */
  private buildNativeSpawnDeps(
    finalRequest: AgentSpawnRequest,
    resolvedAttachments: ReadonlyArray<ResolvedAttachmentItem> | undefined,
    resolvedAnchor: number | undefined,
  ): NativeSpawnDeps {
    return {
      ...this.deps.toolDeps,
      harness: this.deps.harness,
      getLastAssistantText: (id) => this.deps.tracker.getLastAssistantText(id),
      tracker: this.deps.tracker,
      resolveModel: () =>
        resolveDefaultModelRef(
          this.deps.models.defaultModel,
          (ref) => this.deps.models.resolveModelRef(ref),
        ),
      resolveModelRef: (ref) => this.deps.models.resolveModelRef(ref),
      assertModelEnabled: (provider, modelId) => this.deps.models.assertModelEnabled(provider, modelId),
      resolveThinkingLevel: () => this.deps.models.defaultThinkingLevel,
      modelThinkingLevelOf: (ref) => this.deps.models.modelThinkingLevelOf(ref),
      modelsForClamp: () => this.deps.models.models,
      agentSessions: this.agentSessions,
      structuredOutputSessions: this.structuredOutputSessions,
      assertNodeAvailable: (nodeId) => {
        if (!this.deps.envFabric.isOnline(nodeId)) {
          throw new HelmxError('node_offline', `Target node '${nodeId}' is offline; cannot start subagent`, 409, { nodeId })
        }
      },
      ...(resolvedAttachments !== undefined
        ? {
            buildAttachmentsForPrompt: async (effectiveText: string, options?: { suffixText?: string }) => ({
              content: await this.deps.conversations.buildAttachmentContent(effectiveText, resolvedAttachments, options),
              attachments: resolvedAttachments.map((r) => r.ref),
            }),
          }
        : {}),
      resolveProfile: async (profileId) => {
        const profile = await this.deps.conversations.readProfile(profileId)
        return profile === undefined ? undefined : toResolvedProfile(profile)
      },
      getModelOverride: (childId) => this.deps.store.getConv(childId)?.modelOverride,
      getParentOfConversation: (childId) => this.deps.store.getConv(childId)?.parentConversationId,
      getConversation: (childId) => {
        const meta = this.deps.store.getConv(childId)
        return meta ? this.deps.tracker.summaryOf(childId) : undefined
      },
      updateConversation: (childId, patch) => this.deps.updateConversation(childId, patch),
      installChildExtension: (extension) => {
        this.deps.registry.install(extension as never)
      },
      registerChildConversation: async ({
        childId,
        parentId,
        profileId,
        childCwd,
        modelMirror,
        tags,
        thinkingLevel,
        nodeId,
        thinkingLevelOverride,
        title,
      }) => {
        const profile = await this.deps.conversations.readProfile(profileId)
        const parentMeta = this.deps.store.getConv(parentId)
        const { forkSameProfile } = resolveForkMode(profileId, finalRequest.fork, parentMeta?.profileId)
        // Freeze concrete model override at spawn creation time: explicit `tier/<id>` resolves to its
        // concrete `provider/modelId` (`modelMirror`) so later tier edits or plugin disables never bust
        // the child conversation's prompt cache or break resume/reattach.
        const explicitModelOverride =
          finalRequest.model !== undefined && finalRequest.model !== '' ? modelMirror : undefined
        const rawInheritedOverride = resolveInheritedModelOverride(
          explicitModelOverride,
          forkSameProfile,
          parentMeta?.modelOverride,
        )
        // Child conversations never retain symbolic `'tier/<id>'` in `modelOverride`: freeze to concrete `modelMirror`.
        const inheritedModelOverride =
          rawInheritedOverride !== undefined && rawInheritedOverride.startsWith('tier/')
            ? (modelMirror !== '' ? modelMirror : undefined)
            : rawInheritedOverride
        const now = Date.now()
        const normalizedTitle = normalizeSpawnTitle(
          title ?? finalRequest.title,
          childId,
          (text) => this.deps.stashService.redact(text),
        )
        const parentToolCallId = finalRequest.parentToolCallId
        this.deps.store.upsertConv({
          id: childId,
          title: normalizedTitle,
          profileId,
          tags,
          parentConversationId: parentId,
          ...(parentToolCallId !== undefined && parentToolCallId !== '' ? { parentToolCallId } : {}),
          ownedBy: 'helmx',
          nodeId: nodeId ?? resolveSpawnTargetNodeId(profile?.nodeId, parentMeta?.nodeId, forkSameProfile, finalRequest.nodeId),
          cwd: childCwd,
          model: modelMirror,
          thinkingLevel: thinkingLevel ?? '',
          // Clamped explicit override (native execution clamps against target model capability, or inherited on same-profile fork);
          // when unspecified, preserves inheritance chain semantics without persisting an override.
          ...(thinkingLevelOverride !== undefined ? { thinkingLevelOverride } : {}),
          ...(inheritedModelOverride !== undefined && inheritedModelOverride !== ''
            ? { modelOverride: inheritedModelOverride }
            : {}),
          unread: false,
          pinned: false,
          stateChangeSeq: 1,
          completionSeq: 0,
          runDurationMs: 0,
          createdAt: now,
          updatedAt: now,
        })
        const rawBaselineRef =
          inheritedModelOverride ??
          (profile?.model && profile.model !== '' ? profile.model : this.deps.models.defaultModel)
        this.deps.conversations.setEffectiveModelRef?.(childId, rawBaselineRef)
        await this.deps.store.flushPublic()
        await this.deps.tracker.observe(childId)
        if (this.deps.store.getConv(childId) !== undefined && !this.deps.store.isDeleted(childId)) {
          this.deps.events.publish('conversation.upsert', this.deps.conversations.withOwnership(this.deps.tracker.summaryOf(childId)))
        }
      },
      resolveForkAnchor: (parentId: number) =>
        resolvedAnchor !== undefined && parentId === finalRequest.parentConversationId
          ? Promise.resolve(resolvedAnchor)
          : resolveCleanForkAnchor(this.deps.harness, parentId),
      bindChildToolCall: (childId, parentToolCallId) => {
        const meta = this.deps.store.getConv(childId)
        if (meta === undefined || meta.parentToolCallId === parentToolCallId) return
        this.deps.store.upsertConv({ ...meta, parentToolCallId, updatedAt: Date.now() })
        if (!this.deps.store.isDeleted(childId)) {
          this.deps.events.publish('conversation.upsert', this.deps.conversations.withOwnership(this.deps.tracker.summaryOf(childId)))
        }
      },
      // Guarded abort for signal bridge: reads current ownership and authoritative sequence watermark, then re-verifies
      // atomically via kernel abortConversationGuarded (always rejects human-owned — watchdog hard rule; stale facts
      // or disappeared targets reject deterministically, never falling back to unguarded abort).
      abortChildConversationGuarded: async (childId) => {
        const summary = this.deps.conversations.summaryWithOwnership(childId)
        const ownedBy = summary.ownedBy ?? 'human'
        if (ownedBy === 'human') {
          throw new HelmxError(
            'ownership_conflict',
            `Child conversation ${childId} is currently human-owned; refusing automatic abort (watchdog hard rule)`,
            409,
            { conversationId: childId, currentOwnership: ownedBy },
          )
        }
        await this.deps.conversations.abortConversationGuarded(childId, {
          expectedOwnership: ownedBy,
          expectedStateSeq: summary.stateChangeSeq,
        })
      },
    }
  }

  /**
   * Verification Gate (shared by standalone spawns and Workflow adapters; runs once).
   */
  runGate(
    command: string,
    options: {
      cwd?: string
      conversationId?: number
      nodeId?: string
      signal?: AbortSignal
      env?: Record<string, string>
      gateTimeoutMs?: number
    } = {},
  ): Promise<{ ok: boolean; output: string; exitCode?: number | null; timedOut?: boolean }> {
    let nodeId = options.nodeId
    if (nodeId === undefined && options.conversationId !== undefined) {
      nodeId = this.deps.store.getConv(options.conversationId)?.nodeId
    }
    return runGate(this.deps.toolDeps, command, { ...options, ...(nodeId !== undefined ? { nodeId } : {}) })
  }

  /**
   * Unified spawn target resolution (backend for `ctx.host.resolveSpawnTarget`; shares the same authoritative
   * fallback chain as native execution — see `runtime/spawn-target.ts`).
   */
  async resolveSpawnTarget(input: {
    parentConversationId: number
    profileId?: string
    requestNodeId?: string
    requestCwd?: string
    fork?: boolean
  }): Promise<{ nodeId: string; sourceCwd: string; parentCwd: string | undefined }> {
    if (input.requestNodeId !== undefined && !isValidNodeId(input.requestNodeId)) {
      throw new HelmxError(
        'validation_error',
        `requestNodeId must match ${NODE_ID_PATTERN} (received ${String(input.requestNodeId)})`,
        400,
        { requestNodeId: input.requestNodeId },
      )
    }
    const parent = this.deps.store.getConv(input.parentConversationId)
    if (parent === undefined) {
      throw new HelmxError('not_found', `Parent conversation ${input.parentConversationId} not found; cannot resolve spawn target`, 404, {
        parentConversationId: input.parentConversationId,
      })
    }
    const { profileId, forkSameProfile } = resolveForkMode(input.profileId, input.fork, parent.profileId)
    const profile = await this.deps.conversations.readProfile(profileId)
    if (profile === undefined) {
      throw new HelmxError('not_found', `agentType '${profileId}' is not a registered Profile (profiles/${profileId} not found)`, 404)
    }
    if (
      this.deps.toolDeps.restrictToCwdOf !== undefined &&
      (await this.deps.toolDeps.restrictToCwdOf(input.parentConversationId))
    ) {
      this.assertParentCwdScopeViolations({
        parentConversationId: input.parentConversationId,
        parentNodeId: parent.nodeId,
        parentCwd: parent.cwd,
        profileNodeId: profile.nodeId,
        forkSameProfile,
        requestNodeId: input.requestNodeId,
        requestCwd: input.requestCwd,
        nodeLabel: 'resolved',
      })
    }
    // Consolidate source cwd by target node platform (requestNodeId > fork/profile/parent node chain;
    // cross-node cwd isolation prevents leaking foreign parent/profile paths across nodes): worktree
    // source dirs receive the normalized path; unmappable POSIX cwds on win32 targets fail explicitly;
    // unknown remote platforms pass through verbatim. `parentCwd` preserves the parent snapshot verbatim.
    const { nodeId, sourceCwd } = resolveSpawnTargetChain({
      requestNodeId: input.requestNodeId,
      profileNodeId: profile.nodeId,
      parentNodeId: parent.nodeId,
      requestCwd: input.requestCwd,
      profileCwd: profile.cwd,
      parentCwd: parent.cwd,
      defaultCwd: this.deps.toolDeps.defaultCwd,
      forkSameProfile,
      normalize: (cwd, targetNodeId) =>
        normalizeSessionCwd(cwd, {
          nodeId: targetNodeId,
          trustedPlatform: trustedPlatformFromEnvFabric(this.deps.envFabric),
          entry: 'resolve_spawn_target',
        }),
    })
    return { nodeId, sourceCwd, parentCwd: parent.cwd }
  }

  /** Snapshot of spawns currently executing in-process (backend for `ctx.host.listActiveSpawnExecutions`). */
  listActiveSpawnExecutions(): AgentExecutionInfo[] {
    return [...this.activeSpawnExecutions.values()].map((info) => ({ ...info }))
  }

  /**
   * Target node process-occupancy snapshot (backend for `ctx.host.inspectNodePathUsage`):
   * scans live processes on the target node via `EnvFabric` (in-process locally / RPC remotely). Failures
   * (offline, unsupported, permission, incomplete scan) propagate `HelmxError` from fabric — this layer never
   * swallows errors or falls back to local. See `protocol/plugin.ts` for snapshot semantics (non-locking;
   * `complete=false` must fail closed).
   */
  async inspectNodePathUsage(input: {
    nodeId: string
    path: string
    signal?: AbortSignal
  }): Promise<import('@helmx/protocol').NodePathUsage> {
    if (typeof input.nodeId !== 'string' || input.nodeId === '') {
      throw new HelmxError('validation_error', `inspectNodePathUsage requires a non-empty nodeId (received ${String(input.nodeId)})`, 400)
    }
    if (typeof input.path !== 'string' || input.path === '' || input.path.includes('\u0000')) {
      throw new HelmxError('validation_error', 'inspectNodePathUsage requires a non-empty path without NUL bytes', 400)
    }
    return this.deps.envFabric.inspectPathUsage(input.nodeId, input.path, input.signal)
  }
}
