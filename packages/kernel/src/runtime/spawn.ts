/**
 * Native subagent: default `agent_spawn` runner (zero Git/worktree semantics in kernel).
 *
 * - Creates a native child conversation in `pi-durable` and reports `convId` via `onCreated`;
 * - Resume: validates ref strictly (numeric `convId` or existing `agentId` mapping), never silently creating
 *   a new conversation; preserves original conversation's `profileId`/`cwd`/`model` by default (neither recomputes
 *   nor silently reverts to the default Profile); explicit `agentType`/`cwd`/`model` changes apply through the
 *   same `updateConversation` path (real SDK configure + snapshot persistence + model inheritance without rebuilding
 *   identity fields), explicit `effort` updates via `updateConversation`, and `onResolved`/Gate use the updated actual `cwd`;
 * - Schema: full AJV validation (reuses `plugins/schema`, rejects `$async`), self-heals via in-turn
 *   `register_structured_output` tool (injected as per-child extension, see `structured-output.ts`) where invalid tool
 *   params retry within the same turn, falls back to one text re-ask if the tool wasn't used, and throws
 *   `schema_validation_failed` on continued failure (never swallows errors or fabricates data);
 * - Profile: reads the authoritative Profile via `resolveProfile` (`model`/`runtime`); throws explicitly on invalid
 *   profile and fails with `unsupported_runtime` when an external runtime (e.g. `herdr`) wasn't claimed by a plugin;
 * - Gate: runs real shell check (`runGate` in child conversation's actual `cwd`); failure aborts the spawn;
 * - Isolation & execution environment: kernel interprets zero business branches; non-empty `isolation` reaching
 *   native execution means no plugin claimed it via `agent_spawn` continuation (e.g. `builtin:workflow` disabled
 *   with worktree isolation) and fails explicitly with `unsupported_runtime` instead of silently ignoring.
 */

import { randomUUID } from 'node:crypto'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { AgentChange, Conversation, Extension, Submission } from '@earendil-works/pi-durable'
import type {
  AgentSpawnRequest,
  ConversationAttachmentRef,
  ConversationInput,
  ConversationPatch,
  ConversationSummary,
  WhenBusy,
} from '@helmx/protocol'
import { HelmxError, parseModelTierRef, sanitizeAgentNamespacedMeta } from '@helmx/protocol'
import type { Harness } from '@earendil-works/pi-durable'
import type { Models } from '@earendil-works/pi-ai'
import { THINKING_LEVELS, parseModelRef, type ModelRefParts, type ResolvedModelRef } from './models.js'
import type { PromptContent } from './conversation-attachments.js'
import { submitDurableInput, type DurableInputTracker } from './conversation-input.js'
import { asEntryId, asSdkThinkingLevel, getSdkConversation } from './sdk-ids.js'
import { normalizeSessionCwd, trustedPlatformFromEnvFabric } from './target-cwd.js'
import { resolveSpawnTargetChain } from './spawn-target.js'
import {
  resolveCleanForkAnchor,
  resolveForkMode,
  resolveInheritedModelAndThinking,
} from './spawn-fork.js'
import {
  assertSpawnRequestModes,
  readSubmissionAssistantText,
  recoverAcceptedStructuredOutput,
} from './spawn-reattach.js'
import type { HelmxToolDeps } from './tool-deps.js'
import { runGate, MAX_TIMEOUT_MS } from './tools.js'
import {
  STRUCTURED_OUTPUT_EXTENSION_NAME,
  assertSchemaNotAsync,
  buildStructuredOutputExtension,
  parseSchemaCandidate,
  type StructuredOutputSession,
} from './structured-output.js'

const bg = BACKGROUND_CONTEXT

/** Default spawn profile: `assistant` (built-in general profile; never introduces new role enums). */
const DEFAULT_SPAWN_PROFILE = 'assistant'

export { THINKING_LEVELS }

/** Maximum character length for normalized child conversation titles on fresh spawn. */
const MAX_SPAWN_TITLE_LENGTH = 120

/**
 * Boundary validation for optional `AgentSpawnRequest.title`:
 * rejects non-string values and any ASCII control characters (`0x00..0x1F`, `0x7F`).
 */
export function assertSpawnRequestTitle(title: unknown): void {
  if (title === undefined) return
  if (typeof title !== 'string') {
    throw new HelmxError(
      'validation_error',
      `title must be a string (received ${title === null ? 'null' : typeof title})`,
      400,
    )
  }
  for (let i = 0; i < title.length; i += 1) {
    const code = title.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      throw new HelmxError('validation_error', 'title must not contain control characters', 400)
    }
  }
}

/**
 * Normalize a spawn `title` for fresh child conversation creation:
 * trims whitespace, redacts secrets (when a redactor is provided), caps at 120 characters,
 * and falls back to `'subagent <childId>'` when omitted or blank after trim.
 */
export function normalizeSpawnTitle(
  rawTitle: string | undefined,
  childId: number,
  redact?: (text: string) => string,
): string {
  if (rawTitle === undefined) return `subagent ${childId}`
  const trimmed = rawTitle.trim()
  if (trimmed === '') return `subagent ${childId}`
  const redacted = (redact ? redact(trimmed) : trimmed).trim()
  if (redacted === '') return `subagent ${childId}`
  return redacted.slice(0, MAX_SPAWN_TITLE_LENGTH)
}

export interface ResolvedProfile {
  model?: string
  thinkingLevel?: string
  cwd?: string
  /** Profile's default bound compute node (defaults to `'local'`). */
  nodeId?: string
}

export interface RegisterChildConversationOptions {
  readonly childId: number
  readonly parentId: number
  readonly profileId: string
  readonly childCwd: string
  readonly modelMirror: string
  readonly tags: string[]
  readonly thinkingLevel?: string
  readonly nodeId?: string
  readonly thinkingLevelOverride?: string
  readonly title?: string
}

/**
 * Dependency ports for native spawn (host-injected; assembled in `runtime.ts`).
 * `resolveProfile` returning `undefined` means missing profile (throws explicitly instead of defaulting).
 */
export interface NativeSpawnDeps extends HelmxToolDeps {
  harness: Harness
  /** `conversationId ->` latest assistant text (maintained by tracker). */
  getLastAssistantText(conversationId: number): string | undefined
  /** Global default model `'provider/model'` (throws `HelmxError` when unconfigured; carries `tierThinkingLevel` when resolved from a tier). */
  resolveModel(): { provider: string; modelId: string; tierThinkingLevel?: string }
  /** Optional model-reference resolver (`ModelRegistry.resolveModelRef`) to dereference `tier/<id>` into concrete `{ provider, modelId, tierThinkingLevel }`. */
  resolveModelRef?(ref: string): ResolvedModelRef
  /**
   * Current `Models` catalog (used to clamp `thinkingLevel` capabilities; host injects `ModelRegistry.models`).
   * Unset skips clamping (unknown capabilities never break contracts).
   */
  modelsForClamp?(): Models | undefined
  /**
   * Disabled-model preflight (inject `ModelRegistry.assertModelEnabled`): must run right after resolving
   * `resolvedModel` and before creating the child conversation (`409 model_disabled`), ensuring native
   * spawns never bypass disabled-model constraints.
   */
  assertModelEnabled?(provider: string, modelId: string): void
  /** Global default reasoning effort; uses SDK off if unset. */
  resolveThinkingLevel?(): string | undefined
  /**
   * Per-model thinking default lookup (`config.json.modelThinkingLevels`): ranks between explicit effort
   * (or same-model parent override on forks) and the Profile level, mirroring the conversation chain.
   */
  modelThinkingLevelOf?(model: ModelRefParts): string | undefined
  /** `agentId -> child convId` (resume mapping, stable within process). */
  agentSessions: Map<string, number>
  /**
   * Structured-output result slots shared across this `Harness` (`conversationId -> session`): fully assembled hosts
   * (`RuntimeAgentSpawn`) hold and inject this instead of a module-level `WeakMap<Harness, Map>`;
   * concurrent spawns are isolated by `conversationId` key (so even after same-named extensions are replaced in-place
   * on the registry, older extension closures still hit their own slot dynamically).
   * Minimal `runNativeSpawn` setups (without `schema`) may omit it; requests with `schema` missing this fail loudly
   * rather than silently losing structured outputs.
   */
  structuredOutputSessions?: Map<number, StructuredOutputSession>
  /**
   * Optional tracker correlation port for `helmx.input` submissions (`registerInput`/`bindSubmission`/`dropInput`):
   * wired by `RuntimeAgentSpawn` so child turns populate `turn_settled.inputs` cleanly without routing through top-level
   * `input` hooks; standalone `runNativeSpawn` unit tests may omit it.
   */
  tracker?: DurableInputTracker
  /**
   * Record parent-child relationship and validate profile: invalid `profileId` must throw `HelmxError('not_found')`.
   * `childCwd` is the effective cwd used by the child conversation (also used by Gate).
   * `modelMirror` is the resolved model snapshot (`'provider/model'` or `''` if unset).
   * `tags` are child conversation tags (decided by host; native spawn assigns no business role tags).
   * `thinkingLevel` is the effective SDK effort (already clamped to target model capability) to avoid re-reading
   * ambiguous inheritance sources; `thinkingLevelOverride` is the clamped explicit override (`undefined` if
   * `request.effort` was omitted, preserving inheritance chain semantics).
   */
  registerChildConversation(options: RegisterChildConversationOptions): Promise<void>
  /**
   * Update child's `parentToolCallId` on resume to correlate with this parent tool call
   * (optional; host updates snapshot and broadcasts `conversation.upsert`). No-op if untracked.
   */
  bindChildToolCall?(childId: number, parentToolCallId: string): void
  /**
   * Guarded abort for child conversation turns (mandatory entry for auto-cancellations; zero business role special cases):
   * signal bridge and startup cancellations abort through this — host reads current ownership and re-verifies
   * atomically via `abortConversationGuarded` (always rejects human-owned — watchdog hard rule; stale facts
   * reject deterministically). Falls back to SDK `conversation.abort` when unwired (partial tests/standalone).
   */
  abortChildConversationGuarded?(childId: number): Promise<void>
  /** Read raw Profile by `profileId` (`model`/`thinkingLevel`/`cwd`/`runtime`); `undefined` if missing. */
  resolveProfile(profileId: string): Promise<ResolvedProfile | undefined>
  /** Conversation's explicit model override (`modelOverride`); `undefined` if none. */
  getModelOverride(childId: number): string | undefined
  /**
   * Verify child ownership: confirm `childId`'s `parentConversationId` matches request on resume.
   * Returns recorded parent ID, or `undefined` if conversation does not exist.
   */
  getParentOfConversation(childId: number): number | undefined
  /**
   * Read Helmx conversation snapshot (`profileId` / `cwd` / `model` etc. true configuration).
   * Sole source of truth for inherited config on resume; used on creation to fall back to parent cwd
   * (`request > Profile > parent > Hub` chain). Returns `undefined` if missing.
   */
  getConversation(childId: number): ConversationSummary | undefined
  /**
   * Update child configuration (real SDK configure + snapshot persistence + model inheritance recomputation,
   * reusing host `updateConversation` without rebuilding snapshots or overwriting `createdAt`/`title`/`tags`).
   * Explicit `agentType`/`cwd`/`model`/`effort` overrides on resume route through here.
   */
  updateConversation(childId: number, patch: ConversationPatch): Promise<ConversationSummary>
  /**
   * Install per-child extension into SDK registry (StructuredOutput tool requires actual registration
   * before conversations can invoke it by name; re-installing under the same name replaces in place).
   */
  installChildExtension(extension: Extension): void
  /**
   * Build model-visible prompt content (multimodal image blocks + `[Attached Files]` manifest + optional trailing
   * `suffixText`) and lightweight attachment refs for pre-authorized attachments (shared with `ConversationAttachments`).
   */
  buildAttachmentsForPrompt?(
    effectiveText: string,
    options?: { suffixText?: string },
  ): Promise<{ content: PromptContent; attachments: ConversationAttachmentRef[] }>
  /** Node availability preflight (rejects offline). Creation target chain lives in `spawn-target.ts`. */
  assertNodeAvailable?: (nodeId: string) => void
  /** Optional: resolve clean fork anchor entry ID in parent conversation (defaults to `resolveCleanForkAnchor`). */
  resolveForkAnchor?(parentId: number): Promise<number>
}

/**
 * In-flight child conversation spawn mutex (in-process, isolated per `Harness`): sole authoritative lock registry.
 *
 * Shared by two entries so neither misses the other's locks:
 * - `runNativeSpawn` (native runner, including direct test calls and `next` continuations wrapped by around-hooks);
 * - `RuntimeAgentSpawn.spawnAgent` resume preflight (host pipeline entry rejecting before hook chains).
 *
 * Acquisition timing (zero-gap invariant):
 * - Resume: claimed synchronously at entry (before the first `await`);
 * - Create: claimed in the same synchronous slice right after `createConversation` returns and `agentSessions` registers,
 *   closing the gap where the child conversation exists before `onResolved` returns (when its status is not yet
 *   `working` and `activeSpawnExecutions` does not yet hold it).
 *
 * Guarantees in-process exclusivity only (cross-process/cross-restart is governed by durable state and guard ports);
 * external runtimes (e.g. `herdr` panes) enforce resume exclusivity in their own managed registries.
 */
const conversationInTurn = new WeakMap<Harness, Set<number>>()

function inTurnSet(harness: Harness): Set<number> {
  let set = conversationInTurn.get(harness)
  if (set === undefined) {
    set = new Set<number>()
    conversationInTurn.set(harness, set)
  }
  return set
}

/** Claim exclusive turn ownership of a child conversation (synchronous, zero await); throws `409 subagent_in_use` if busy. */
export function claimSpawnConversation(harness: Harness, childId: number): void {
  const set = inTurnSet(harness)
  if (set.has(childId)) {
    throw new HelmxError('subagent_in_use', `Child conversation ${childId} already has an execution in flight; concurrent resume is not allowed`, 409, { conversationId: childId })
  }
  set.add(childId)
}

/** Release claim (`finally` path; idempotent). */
function releaseSpawnConversation(harness: Harness, childId: number): void {
  inTurnSet(harness).delete(childId)
}

/** Read-only probe (used for early rejection at host pipeline entry; does not claim). */
export function isSpawnConversationInTurn(harness: Harness, childId: number): boolean {
  return conversationInTurn.get(harness)?.has(childId) ?? false
}

export async function runNativeSpawn(deps: NativeSpawnDeps, request: AgentSpawnRequest): Promise<unknown> {
  // Envelope boundary (synchronous): `meta` must be a JSON-safe namespaced object (re-checked after
  // hook transforms; plugin-specific contents are validated by their respective plugin boundaries).
  sanitizeAgentNamespacedMeta(request.meta, { agentId: request.agentId ?? 'subagent', field: 'spawn request meta' })
  assertSpawnRequestShape(request)
  const resumeChildId =
    request.resume === undefined ? undefined : resolveResumeRef(deps, request.resume, request.parentConversationId)
  const reattachChildId =
    request.reattach?.conversationId === undefined
      ? undefined
      : resolveReattachRef(deps, request.reattach.conversationId, request.parentConversationId)
  if (reattachChildId !== undefined && request.requestId === undefined) {
    throw new HelmxError(
      'validation_error',
      'reattach.conversationId requires requestId for idempotent cross-restart reattachment',
      400,
      { conversationId: reattachChildId },
    )
  }
  if (resumeChildId !== undefined) {
    // Status preflight complements `claim` as a second guard (covers historical in-flight runs outside this table).
    const status = deps.getConversation(resumeChildId)?.status
    if (status === 'working' || status === 'blocked') {
      throw new HelmxError('subagent_in_use', `Child conversation ${resumeChildId} already has an execution in flight; concurrent resume is not allowed`, 409, {
        conversationId: resumeChildId,
      })
    }
  }
  const claimedChildId = resumeChildId ?? reattachChildId
  if (claimedChildId !== undefined) {
    claimSpawnConversation(deps.harness, claimedChildId)
  }
  const execution: NativeSpawnExecution = {}
  try {
    return await runNativeSpawnTurn(deps, request, execution, reattachChildId)
  } finally {
    if (claimedChildId !== undefined) releaseSpawnConversation(deps.harness, claimedChildId)
    if (execution.childId !== undefined) releaseSpawnConversation(deps.harness, execution.childId)
  }
}

/** Channel passing back newly spawned child ID (claimed synchronously upon creation, released uniformly by outer `finally`). */
interface NativeSpawnExecution {
  childId?: number
}

/** Resume resolution result: discriminated union narrowing `childId` and `existing` snapshot on resume. */
type SpawnResumeContext =
  | { readonly isResume: false }
  | { readonly isResume: true; readonly childId: number; readonly existing: ConversationSummary }

/** Bound structured-output session plus owning Harness map (eliminates non-null assertions). */
interface PreparedStructuredOutput {
  readonly session: StructuredOutputSession
  readonly sessions: Map<number, StructuredOutputSession>
}

interface ResolveSpawnTargetForRequestOptions {
  readonly deps: NativeSpawnDeps
  readonly request: AgentSpawnRequest
  readonly profile: ResolvedProfile
  readonly parentSummary: ConversationSummary | undefined
  readonly forkSameProfile: boolean
  readonly resumeSummary: ConversationSummary | undefined
}

interface CreateChildConversationOptions {
  readonly deps: NativeSpawnDeps
  readonly request: AgentSpawnRequest
  readonly execution: NativeSpawnExecution
  readonly profile: ResolvedProfile
  readonly profileId: string
  readonly structured: PreparedStructuredOutput | undefined
  readonly target: SpawnTarget
  readonly parentSummary: ConversationSummary | undefined
  readonly forkSameProfile: boolean
}

/** Spawn target resolution result: target node + effective cwd for child conversation (shared by gate and `onResolved`). */
interface SpawnTarget {
  nodeId: string
  childCwd: string
}

async function runNativeSpawnTurn(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  execution: NativeSpawnExecution,
  reattachChildId: number | undefined,
): Promise<unknown> {
  if (reattachChildId !== undefined) {
    return await runNativeReattachTurn(deps, request, reattachChildId)
  }

  const resume = resolveSpawnResume(deps, request)
  const parentSummary = deps.getConversation(request.parentConversationId)
  if (request.fork === true && parentSummary === undefined) {
    throw new HelmxError('not_found', `Parent conversation ${request.parentConversationId} not found; cannot fork`, 404, {
      parentConversationId: request.parentConversationId,
    })
  }

  const { profileId, forkSameProfile } = resume.isResume
    ? { profileId: request.agentType ?? resume.existing.profileId, forkSameProfile: false }
    : resolveForkMode(request.agentType, request.fork, parentSummary?.profileId, DEFAULT_SPAWN_PROFILE)
  const profile = await resolveProfileForSpawn(deps, profileId)

  const summary = resume.isResume
    ? await applyResumeConfiguration({
        deps,
        request,
        childId: resume.childId,
        existing: resume.existing,
        profileId,
      })
    : undefined

  const target = resolveSpawnTargetForRequest({
    deps,
    request,
    profile,
    parentSummary,
    forkSameProfile,
    resumeSummary: summary,
  })
  const gateCwd = target.childCwd

  const structured = prepareStructuredSession(deps, request)
  let childId: number
  if (!resume.isResume) {
    childId = await createChildConversation({
      deps,
      request,
      execution,
      profile,
      profileId,
      structured,
      target,
      parentSummary,
      forkSameProfile,
    })
  } else {
    childId = resume.childId
    notifyResumeResolved(deps, request, childId, target)
  }

  const conversation = await getSdkConversation(deps.harness, childId, bg)
  if (!conversation) {
    throw new HelmxError('not_found', `Child conversation not found: ${childId}`, 404)
  }

  if (resume.isResume && structured) {
    const extension = buildStructuredOutputExtension(structured.sessions)
    deps.installChildExtension(extension)
    await conversation.configure({ extensions: { add: [extension] } }, bg)
  }

  return await runChildTurn({ deps, request, conversation, childId, structured, gateCwd })
}

/**
 * Reattach in-place to an existing child conversation: never creates or reconfigures,
 * registers `structuredOutputSessions` before harness resume, and awaits the durable `SubmissionHandle`.
 */
async function runNativeReattachTurn(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  childId: number,
): Promise<unknown> {
  const existing = deps.getConversation(childId)
  const parent = deps.getParentOfConversation(childId)
  if (existing === undefined || parent === undefined || parent !== request.parentConversationId) {
    throw new HelmxError(
      'not_found',
      `Reattach target child conversation ${childId} does not exist or does not belong to parent conversation ${request.parentConversationId}`,
      404,
      { conversationId: childId, parentConversationId: request.parentConversationId },
    )
  }
  const target: SpawnTarget = {
    nodeId: existing.nodeId ?? 'local',
    childCwd: existing.cwd !== '' ? existing.cwd : (request.reattach?.effectiveCwd ?? deps.defaultCwd),
  }
  const structured = prepareStructuredSession(deps, request)
  if (request.agentId) deps.agentSessions.set(request.agentId, childId)
  notifyResumeResolved(deps, request, childId, target)

  let structuredExtension: Extension | undefined
  if (structured !== undefined) {
    structured.sessions.set(childId, structured.session)
    structuredExtension = buildStructuredOutputExtension(structured.sessions)
    deps.installChildExtension(structuredExtension)
  }

  const conversation = await getSdkConversation(deps.harness, childId, bg)
  if (!conversation) {
    if (structured !== undefined && structured.sessions.get(childId) === structured.session) {
      structured.sessions.delete(childId)
    }
    throw new HelmxError('not_found', `Child conversation not found: ${childId}`, 404, { conversationId: childId })
  }
  if (structured !== undefined && structuredExtension !== undefined) {
    const agent = await conversation.agent(bg)
    if (!agent.extensions.some((ext) => ext.name === STRUCTURED_OUTPUT_EXTENSION_NAME)) {
      await conversation.configure({ extensions: { add: [structuredExtension] } }, bg)
    }
  }
  return await runChildTurn({ deps, request, conversation, childId, structured, gateCwd: target.childCwd })
}

/** Strict synchronous validation of request shape (fails explicitly, never coerces silently). */
function assertSpawnRequestShape(request: AgentSpawnRequest): void {
  assertSpawnRequestModes(request)
  assertSpawnRequestTitle(request.title)
  if (request.isolation !== undefined && request.isolation !== null && request.isolation !== '') {
    // Kernel has zero business branches: non-empty isolation reaching native execution means no plugin claimed it
    // via `agent_spawn` continuation (e.g., `builtin:worktree` disabled when worktree isolation was requested).
    throw new HelmxError(
      'unsupported_runtime',
      `isolation='${request.isolation}' is not supported here: native subagent execution does not implement isolated execution environments (handled by the corresponding plugin via the agent_spawn hook, which is currently unregistered or disabled)`,
      400,
    )
  }
  if (request.signal?.aborted) {
    throw new HelmxError('aborted', 'Spawn request aborted before child creation (signal already aborted)', 409)
  }
  const agentType = request.agentType ?? ''
  // Common namespace prefix rule: any '<namespace>:<kind>' external runtime (e.g. 'herdr:agy', 'docker:devbox')
  // must be claimed by an `agent_spawn` hook; without hardcoding plugin names, kernel always throws `unsupported_runtime`.
  if (agentType.includes(':')) {
    throw new HelmxError(
      'unsupported_runtime',
      `agentType '${agentType}' is a namespaced external runtime identifier that must be claimed via the agent_spawn hook (no matching runtime is currently registered)`,
      400,
    )
  }
  if (request.effort !== undefined && !THINKING_LEVELS.has(request.effort)) {
    throw new HelmxError(
      'validation_error',
      `Invalid effort '${request.effort}'; valid values: ${[...THINKING_LEVELS].join(' | ')}`,
      400,
    )
  }
  if (request.gateTimeoutMs !== undefined) assertGateTimeoutMs(request.gateTimeoutMs)
}

/** Strict resume resolution: missing ref, mismatched parent, or missing snapshot fail explicitly rather than creating a new conversation. */
function resolveSpawnResume(deps: NativeSpawnDeps, request: AgentSpawnRequest): SpawnResumeContext {
  const resumeRef = request.resume
  if (resumeRef === undefined) return { isResume: false }
  const childId = resolveResumeRef(deps, resumeRef, request.parentConversationId)
  if (childId === undefined) {
    throw new HelmxError(
      'not_found',
      `Resume target '${resumeRef}' was not found or does not belong to parent conversation ${request.parentConversationId}: ` +
        `neither an existing agentId mapping nor a valid child conversation ID; refusing to create a new conversation instead`,
      404,
    )
  }
  const existing = deps.getConversation(childId)
  if (existing === undefined) {
    throw new HelmxError(
      'not_found',
      `Resumed conversation ${childId} has no snapshot record (inconsistent host state); refusing blind resume`,
      404,
      { conversationId: childId },
    )
  }
  return { isResume: true, childId, existing }
}

/** Profile resolution: 404 when missing. */
async function resolveProfileForSpawn(deps: NativeSpawnDeps, profileId: string): Promise<ResolvedProfile> {
  const profile = await deps.resolveProfile(profileId)
  if (profile === undefined) {
    throw new HelmxError(
      'not_found',
      `agentType '${profileId}' is not a registered Profile (profiles/${profileId} not found)`,
      404,
    )
  }
  return profile
}

/** Apply resume configuration updates: sync explicit `agentType`/`cwd`/`model`/`effort` changes via `updateConversation`,
 * then run disabled-model preflight on the effective model (`409 model_disabled`). */
async function applyResumeConfiguration(options: {
  deps: NativeSpawnDeps
  request: AgentSpawnRequest
  childId: number
  existing: ConversationSummary
  profileId: string
}): Promise<ConversationSummary> {
  const { deps, request, childId, existing, profileId } = options
  let summary: ConversationSummary = existing
  const patch: ConversationPatch = {}
  if (request.agentType !== undefined && request.agentType !== existing.profileId) {
    patch.profileId = profileId
  }
  if (request.cwd !== undefined && request.cwd !== existing.cwd) patch.cwd = request.cwd
  if (
    request.model !== undefined &&
    (parseModelTierRef(request.model) !== undefined || request.model !== deps.getModelOverride(childId))
  ) {
    patch.model = request.model
  }
  if (request.effort !== undefined) patch.thinkingLevel = request.effort
  if (Object.keys(patch).length > 0) {
    summary = await deps.updateConversation(childId, patch)
  }
  if (summary.model !== '') {
    const modelRef = parseModelRef(summary.model)
    deps.assertModelEnabled?.(modelRef.provider, modelRef.modelId)
  }
  return summary
}

/** Target resolution: resume preserves snapshot verbatim; creation follows `request > profile > parent` chain
 * (normalized per target node platform before SDK `createConversation` / mirror registration / gate / `onResolved`:
 * unmappable POSIX cwds on win32 fail explicitly; unknown remote platforms pass through verbatim). */
function resolveSpawnTargetForRequest(options: ResolveSpawnTargetForRequestOptions): SpawnTarget {
  const { deps, request, profile, parentSummary, forkSameProfile, resumeSummary } = options
  let nodeId: string
  let childCwd: string
  if (resumeSummary !== undefined) {
    nodeId = resumeSummary.nodeId ?? 'local'
    childCwd = resumeSummary.cwd
  } else {
    const chain = resolveSpawnTargetChain({
      requestNodeId: request.nodeId,
      profileNodeId: profile.nodeId,
      parentNodeId: parentSummary?.nodeId,
      requestCwd: request.cwd,
      profileCwd: profile.cwd,
      parentCwd: parentSummary?.cwd,
      defaultCwd: deps.defaultCwd,
      forkSameProfile,
      normalize: (cwd, targetNodeId) =>
        normalizeSessionCwd(cwd, {
          nodeId: targetNodeId,
          trustedPlatform: trustedPlatformFromEnvFabric(deps.envFabric),
          entry: 'agent_spawn',
        }),
    })
    nodeId = chain.nodeId
    childCwd = chain.sourceCwd
  }
  deps.assertNodeAvailable?.(nodeId)
  return { nodeId, childCwd }
}

/** Initialize structured-output session slot (plain-text spawn when schema is omitted). */
function prepareStructuredSession(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
): PreparedStructuredOutput | undefined {
  if (!request.schema) return undefined
  assertSchemaNotAsync(request.schema)
  if (deps.structuredOutputSessions === undefined) {
    throw new HelmxError(
      'invalid_state',
      'Request specifies schema but host did not inject structuredOutputSessions (wiring defect): nowhere to register structured output slot',
      500,
    )
  }
  return {
    sessions: deps.structuredOutputSessions,
    session: { schema: request.schema, accepted: undefined },
  }
}

/** Create new child conversation: model resolution -> disabled preflight -> extension install -> create/fork ->
 * claim gap window -> snapshot registration -> `onResolved` metadata callback. */
async function createChildConversation(options: CreateChildConversationOptions): Promise<number> {
  const {
    deps,
    request,
    execution,
    profile,
    profileId,
    structured,
    target,
    parentSummary,
    forkSameProfile,
  } = options
  const { resolvedModel, createModelRef, thinkingLevel, thinkingLevelOverride } = resolveInheritedModelAndThinking({
    request,
    forkSameProfile,
    profile,
    parentSummary,
    defaultModel: deps.resolveModel,
    resolveModelRef: deps.resolveModelRef,
    defaultThinkingLevel: deps.resolveThinkingLevel,
    modelThinkingLevelOf: deps.modelThinkingLevelOf,
    modelsForClamp: deps.modelsForClamp?.(),
  })
  deps.assertModelEnabled?.(resolvedModel.provider, resolvedModel.modelId)
  const extension = structured ? buildStructuredOutputExtension(structured.sessions) : undefined
  const extensionsChange = extension
    ? { add: [extension] }
    : request.fork === true
      ? { remove: [{ name: STRUCTURED_OUTPUT_EXTENSION_NAME } as Extension] }
      : undefined
  const sdkThinking = asSdkThinkingLevel(thinkingLevel)
  const agentChange: AgentChange = {
    model: { provider: resolvedModel.provider, modelId: resolvedModel.modelId },
    cwd: target.childCwd,
    ...(sdkThinking !== undefined
      ? { thinkingLevel: sdkThinking }
      : request.fork === true
        ? { thinkingLevel: null }
        : {}),
    ...(extensionsChange !== undefined ? { extensions: extensionsChange } : {}),
  }
  let conv: Conversation
  if (request.fork === true) {
    const parentConv = await getSdkConversation(deps.harness, request.parentConversationId, bg)
    if (!parentConv) {
      throw new HelmxError('not_found', `Parent conversation not found: ${request.parentConversationId}`, 404, {
        parentConversationId: request.parentConversationId,
      })
    }
    const anchorEntryId = await (deps.resolveForkAnchor
      ? deps.resolveForkAnchor(request.parentConversationId)
      : resolveCleanForkAnchor(deps.harness, request.parentConversationId))
    if (extension) deps.installChildExtension(extension)
    conv = await parentConv.fork(
      asEntryId(anchorEntryId),
      { ownership: { kind: 'ownerless' }, agent: agentChange },
      bg,
    )
  } else {
    if (extension) deps.installChildExtension(extension)
    conv = await deps.harness.createConversation(
      { ownership: { kind: 'ownerless' }, agent: agentChange },
      bg,
    )
  }
  const childId = Number(conv.id)
  if (request.agentId) deps.agentSessions.set(request.agentId, childId)
  claimSpawnConversation(deps.harness, childId)
  execution.childId = childId
  const resolvedTitle = normalizeSpawnTitle(request.title, childId, deps.redact)
  await deps.registerChildConversation({
    childId,
    parentId: request.parentConversationId,
    profileId,
    childCwd: target.childCwd,
    modelMirror: createModelRef,
    tags: [],
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    nodeId: target.nodeId,
    ...(thinkingLevelOverride !== undefined ? { thinkingLevelOverride } : {}),
    title: resolvedTitle,
  })
  request.onResolved?.({
    nodeId: target.nodeId,
    conversationId: childId,
    effectiveCwd: target.childCwd,
  })
  return childId
}

/** On resume: `updateConversation` already synced model/cwd/effort to SDK and snapshot;
 * sync `parentToolCallId` immediately so live call correlation points to this child, and report updated `cwd` via `onResolved`. */
function notifyResumeResolved(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  childId: number,
  target: SpawnTarget,
): void {
  if (request.parentToolCallId !== undefined && request.parentToolCallId !== '') {
    deps.bindChildToolCall?.(childId, request.parentToolCallId)
  }
  request.onResolved?.({
    nodeId: target.nodeId,
    conversationId: childId,
    effectiveCwd: target.childCwd,
  })
}

/** Submit and monitor child conversation turn.
 *
 * ---- Signal bridge: abort child guardedly when parent aborts; remove listener in `finally`. ----
 * Routes through the host's guarded entry (atomically re-checking ownership+watermark; refuses human-owned)
 * instead of raw `conversation.abort` — unconditionally killing a child conversation resumed by a human would
 * violate the watchdog hard rule. When refused by the guard, the protected child keeps running independently while
 * the parent immediately terminates with `aborted` rather than forcing cancellation.
 */
async function runChildTurn(options: {
  deps: NativeSpawnDeps
  request: AgentSpawnRequest
  conversation: Awaited<ReturnType<Harness['conversation']>> & object
  childId: number
  structured: PreparedStructuredOutput | undefined
  gateCwd: string
}): Promise<unknown> {
  const { deps, request, conversation, childId, structured, gateCwd } = options
  if (structured !== undefined) structured.sessions.set(childId, structured.session)

  const abortChildTurn = (): Promise<void> => {
    const guarded = deps.abortChildConversationGuarded
    if (guarded !== undefined) return guarded(childId)
    return Promise.resolve(conversation.abort(bg)).then(() => undefined)
  }
  let abortError: HelmxError | undefined
  let releaseParentOnGuardRefusal: ((error: HelmxError) => void) | undefined
  const onAbort = () => {
    abortError = new HelmxError('aborted', 'Subagent execution was cancelled (request.signal aborted)', 499, {
      conversationId: childId,
    })
    void abortChildTurn().then(
      () => {},
      (guardError: unknown) => {
        const rawMessage = guardError instanceof Error ? guardError.message : String(guardError)
        const message = deps.redact(rawMessage)
        abortError = new HelmxError(
          'aborted',
          `Subagent execution was cancelled; child conversation ${String(childId)} is guard-protected and was not aborted (${message})`,
          499,
          { conversationId: childId },
        )
        process.stderr.write(`[helmx] child conversation ${String(childId)} abort refused/failed: ${message}\n`)
        releaseParentOnGuardRefusal?.(abortError)
      },
    )
  }
  if (request.signal) request.signal.addEventListener('abort', onAbort, { once: true })
  const guardRefusal = new Promise<never>((_, reject) => {
    releaseParentOnGuardRefusal = reject
  })
  try {
    if (request.signal?.aborted) {
      await abortChildTurn().catch((error: unknown) => {
        const rawMessage = error instanceof Error ? error.message : String(error)
        process.stderr.write(
          `[helmx] child conversation ${String(childId)} startup abort refused/failed: ${deps.redact(rawMessage)}\n`,
        )
      })
      throw new HelmxError('aborted', 'Subagent execution cancelled during startup', 499, { conversationId: childId })
    }
    const turn = driveTurn({ deps, request, conversation, childId, structured, gateCwd })
    void turn.catch(() => {})
    return await Promise.race([turn, guardRefusal])
  } catch (error) {
    if (abortError !== undefined && error !== abortError) throw abortError
    throw error
  } finally {
    if (request.signal) request.signal.removeEventListener('abort', onAbort)
    if (structured !== undefined && structured.sessions.get(childId) === structured.session) {
      structured.sessions.delete(childId)
    }
  }
}

/** Submit one child turn through the shared hook-free durable input primitive (`helmx.input` + compaction mutex + tracker correlation). */
async function submitChildInput(
  deps: NativeSpawnDeps,
  conversation: Awaited<ReturnType<Harness['conversation']>> & object,
  childId: number,
  options: {
    text: string
    content: PromptContent
    whenBusy: WhenBusy
    requestId?: string
    attachments?: ConversationAttachmentRef[]
  },
): Promise<Submission> {
  const inputId = options.requestId ?? randomUUID()
  const input: ConversationInput = {
    id: inputId,
    text: options.text,
    origin: 'agent',
    whenBusy: options.whenBusy,
    createdAt: Date.now(),
    ...(options.attachments !== undefined && options.attachments.length > 0
      ? { attachments: options.attachments }
      : {}),
  }
  const { submission } = await submitDurableInput({
    harness: deps.harness,
    conversation,
    conversationId: childId,
    input,
    whenBusy: options.whenBusy,
    content: options.content,
    requestId: inputId,
    tracker: deps.tracker,
  })
  return submission
}

/** Submit a turn, await completion, and inspect terminal status (structured branch checks settled output before text). */
async function driveTurn(options: {
  deps: NativeSpawnDeps
  request: AgentSpawnRequest
  conversation: Awaited<ReturnType<Harness['conversation']>> & object
  childId: number
  structured: PreparedStructuredOutput | undefined
  gateCwd: string
}): Promise<unknown> {
  const { deps, request, conversation, childId, structured, gateCwd } = options
  const effectivePrompt = deps.redact ? deps.redact(request.prompt) : request.prompt
  const contractSuffix = structured
    ? `<structured_output_contract>
After finishing your answer, call the register_structured_output tool to submit your final structured result (the output parameter must satisfy the JSON Schema below).
Schema: ${JSON.stringify(structured.session.schema)}
</structured_output_contract>`
    : undefined

  // Attachments were already authorized by host; reuse shared ConversationAttachments content builder
  // so native spawns emit identical [Attached Files] + multimodal ImageContent blocks before the output contract.
  let content: PromptContent
  let attachments: ConversationAttachmentRef[] | undefined
  if (
    request.attachments !== undefined &&
    request.attachments.length > 0 &&
    deps.buildAttachmentsForPrompt !== undefined
  ) {
    const built = await deps.buildAttachmentsForPrompt(effectivePrompt, {
      ...(contractSuffix !== undefined ? { suffixText: contractSuffix } : {}),
    })
    content = built.content
    attachments = built.attachments
  } else {
    content =
      contractSuffix !== undefined
        ? effectivePrompt.length > 0
          ? `${effectivePrompt}\n\n${contractSuffix}`
          : contractSuffix
        : effectivePrompt
  }

  // Busy mode: steer (unified default); reattach uses followUp as safety net behind requestId dedup.
  const submission = await submitChildInput(deps, conversation, childId, {
    text: effectivePrompt,
    content,
    whenBusy: request.reattach !== undefined ? 'followUp' : 'steer',
    ...(request.requestId !== undefined ? { requestId: request.requestId } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
  })
  const settled = await submission.wait(bg)
  assertNotUnanswered(settled, childId)

  const resolveTurnText = async (
    turnSettled: typeof settled,
  ): Promise<string | undefined> => {
    if (
      typeof conversation.entries === 'function' &&
      turnSettled.type === 'input' &&
      turnSettled.status === 'done' &&
      turnSettled.answer !== undefined
    ) {
      return await readSubmissionAssistantText(conversation, turnSettled, { redact: deps.redact })
    }
    const fallback = deps.getLastAssistantText(childId)
    if (fallback === undefined) return undefined
    return deps.redact ? deps.redact(fallback) : fallback
  }

  if (structured) {
    if (structured.session.accepted !== undefined) {
      await settleGate(deps, request, gateCwd, childId)
      return structured.session.accepted
    }
    if (settled.type === 'input' && settled.entry !== undefined) {
      const recovered = await recoverAcceptedStructuredOutput(
        conversation,
        structured.session.schema,
        settled.entry,
        settled.answer,
      )
      if (recovered.found) {
        structured.session.accepted = recovered.value
        await settleGate(deps, request, gateCwd, childId)
        return structured.session.accepted
      }
    }
    // Tool not called: send one text self-heal follow-up (model may have printed raw JSON directly).
    const text = (await resolveTurnText(settled)) ?? ''
    const parsed = parseSchemaCandidate(text, structured.session.schema)
    if (parsed.ok) {
      await settleGate(deps, request, gateCwd, childId)
      return parsed.value
    }
    const healRequestId = request.requestId !== undefined ? `${request.requestId}:schema-heal` : undefined
    const healPrompt =
      `Your previous response did not submit the result via the register_structured_output tool. Please call ` +
      `register_structured_output immediately with an output parameter containing valid JSON matching the Schema below.` +
      `
Schema: ${JSON.stringify(structured.session.schema)}`
    const heal = await submitChildInput(deps, conversation, childId, {
      text: healPrompt,
      content: healPrompt,
      whenBusy: 'steer',
      ...(healRequestId !== undefined ? { requestId: healRequestId } : {}),
    })
    const healSettled = await heal.wait(bg)
    assertNotUnanswered(healSettled, childId)
    if (structured.session.accepted !== undefined) {
      await settleGate(deps, request, gateCwd, childId)
      return structured.session.accepted
    }
    if (healSettled.type === 'input' && healSettled.entry !== undefined) {
      const recoveredHeal = await recoverAcceptedStructuredOutput(
        conversation,
        structured.session.schema,
        healSettled.entry,
        healSettled.answer,
      )
      if (recoveredHeal.found) {
        structured.session.accepted = recoveredHeal.value
        await settleGate(deps, request, gateCwd, childId)
        return structured.session.accepted
      }
    }
    const lastText = (await resolveTurnText(healSettled)) ?? ''
    const retry = parseSchemaCandidate(lastText, structured.session.schema)
    if (retry.ok) {
      await settleGate(deps, request, gateCwd, childId)
      return retry.value
    }
    throw new HelmxError(
      'schema_validation_failed',
      `Subagent (conversation ${childId}) failed Schema validation twice; final output starts with: ${(retry.raw || lastText).slice(0, 200)}`,
      502,
      { conversationId: childId, lastText: lastText.slice(0, 1000) },
    )
  }

  await settleGate(deps, request, gateCwd, childId)
  const text = await resolveTurnText(settled)
  if (text === undefined || text === '') {
    throw new HelmxError('subagent_failed', `Subagent (conversation ${childId}) completed without text output`, 502, {
      conversationId: childId,
    })
  }
  return text
}

/** Fail explicitly on incomplete turns (failed/aborted, etc.) instead of returning stale assistant text. */
function assertNotUnanswered(settled: { status: string; reason?: string }, childId: number): void {
  if (settled.status !== 'unanswered') return
  throw new HelmxError(
    'subagent_failed',
    `Subagent (conversation ${childId}) turn did not complete: ${settled.reason}`,
    502,
    { conversationId: childId, reason: settled.reason },
  )
}

async function settleGate(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  cwd: string,
  childId: number,
): Promise<void> {
  if (!request.gate) return
  // Run verification command in the child's actual working directory (independent of caller cwd);
  // output flows directly into diagnostics rather than injecting conversation-level stash env.
  // Passing `conversationId` resolves the child's bound node so remote spawns verify on their target node;
  // `gateTimeoutMs` defaults to 120_000 in `runGate`, killing the whole process group on timeout.
  const gate = await runGate(deps, request.gate, {
    cwd,
    conversationId: childId,
    signal: request.signal,
    ...(request.gateTimeoutMs !== undefined ? { timeoutMs: request.gateTimeoutMs } : {}),
  })
  // Report complete gate outcome (`exitCode`/`timedOut`) back once for host failure/retry decisions (prevents double execution).
  request.onGateResult?.({
    ok: gate.ok,
    output: gate.output,
    exitCode: gate.exitCode,
    timedOut: gate.timedOut,
  })
  if (!gate.ok) {
    const label = gate.timedOut ? 'timed out and was forcibly terminated' : `exitCode=${gate.exitCode}`
    throw new HelmxError(
      'gate_failed',
      `Verification command failed (${label}): ${request.gate}\n${gate.output.slice(-2000)}`,
      502,
      {
        exitCode: gate.exitCode,
        timedOut: gate.timedOut,
        output: gate.output.slice(-4000),
      },
    )
  }
}

/** Validate `gateTimeoutMs`: must be integer in `(0, MAX_TIMEOUT_MS]` (matching `bash`/`runGate` limits). */
function assertGateTimeoutMs(value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new HelmxError(
      'validation_error',
      `gateTimeoutMs must be an integer in (0, ${MAX_TIMEOUT_MS}], received ${value}`,
      400,
      { gateTimeoutMs: value },
    )
  }
}

/**
 * Strict resume ref resolution: accepts only decimal integer `convId` (after resolving `agentId` mappings).
 * Conversation must exist with matching parent; returns `undefined` on any mismatch so callers fail explicitly
 * rather than coercing `parseInt('12abc')` or silently creating a fresh conversation.
 */
function resolveResumeRef(deps: NativeSpawnDeps, ref: string, parentId: number): number | undefined {
  const mapped = deps.agentSessions.get(ref)
  const candidate = mapped ?? (/^\d+$/.test(ref) ? Number(ref) : undefined)
  if (candidate === undefined || !Number.isSafeInteger(candidate) || candidate <= 0) return undefined
  const parent = deps.getParentOfConversation(candidate)
  if (parent === undefined || parent !== parentId) return undefined
  return candidate
}

/**
 * Strict `reattach.conversationId` validation: must be a positive safe integer belonging to an existing
 * conversation under `parentId`; otherwise rejects with 404/400 rather than spawning a fake replacement.
 */
function resolveReattachRef(deps: NativeSpawnDeps, convId: number, parentId: number): number {
  if (!Number.isSafeInteger(convId) || convId <= 0) {
    throw new HelmxError(
      'validation_error',
      `reattach.conversationId must be a positive safe integer (received ${String(convId)})`,
      400,
      { conversationId: convId },
    )
  }
  const parent = deps.getParentOfConversation(convId)
  const existing = deps.getConversation(convId)
  if (existing === undefined || parent === undefined || parent !== parentId) {
    throw new HelmxError(
      'not_found',
      `Reattach target child conversation ${convId} does not exist or does not belong to parent conversation ${parentId}; refusing to create a new conversation instead`,
      404,
      { conversationId: convId, parentConversationId: parentId },
    )
  }
  return convId
}
