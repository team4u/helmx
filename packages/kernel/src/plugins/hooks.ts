/**
 * Priority-ordered hook pipeline shared across the 4 backend hook points (zero business hardcoding).
 *
 * Semantics:
 * - Higher priority runs first; ties preserve registration order (`Array.prototype.sort` is stable);
 * - Returning `void`/`undefined` is equivalent to `continue`;
 * - `transform.value` is validated against the hook payload schema before passing downstream;
 * - `handled`/`block` short-circuits remaining handlers;
 * - Invalid return shapes throw `invalid_hook_result`; exceptions wrap as `hook_execution_failed`.
 */
import {
  HelmxError,
  type AgentSpawnRequest,
  type BeforeTurnHookPayload,
  type HookHandler,
  type HookName,
  type HookPayloadMap,
  type HookResult,
  type InputHookPayload,
  type TurnSettledPayload,
} from '@helmx/protocol';

/**
 * Allowed return actions per hook point:
 * - `input`: may intercept (`handled`/`block`) or transform;
 * - `before_turn`: supports `continue` and `transform` (in-place or transformed payload);
 * - `agent_spawn`: may transform, wrap via `next`, or take over via `handled`;
 * - `turn_settled`: notification hook (no `block`).
 */
export const HOOK_ALLOWED_ACTIONS: Record<HookName, ReadonlySet<string>> = {
  input: new Set(['continue', 'transform', 'handled', 'block']),
  before_turn: new Set(['continue', 'transform']),
  agent_spawn: new Set(['continue', 'transform', 'handled']),
  turn_settled: new Set(['continue', 'transform', 'handled']),
};

interface RegisteredHook<K extends HookName = HookName> {
  pluginId: string;
  priority: number;
  /** Registration sequence number used as tie-breaker in stable sort. */
  seq: number;
  handler: HookHandler<K>;
}

// ---------------------------------------------------------------------------
// Runtime payload validation (pipeline entry, post-transform, and host defaults)
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqString(o: Record<string, unknown>, k: string): string | null {
  return typeof o[k] === 'string' && (o[k] as string).length > 0 ? null : `field ${k} must be a non-empty string`;
}

/** String type check permitting empty string (unconfigured models default to `''` before `submitInput`). */
function strAllowEmpty(o: Record<string, unknown>, k: string): string | null {
  return typeof o[k] === 'string' ? null : `field ${k} must be a string (empty string allowed)`;
}

function reqPositiveInt(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === 'number' && Number.isInteger(v) && (v as number) > 0
    ? null
    : `field ${k} must be a positive integer`;
}

function reqNonNegativeInt(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === 'number' && Number.isInteger(v) && (v as number) >= 0
    ? null
    : `field ${k} must be a non-negative integer`;
}

function reqArray(o: Record<string, unknown>, k: string): string | null {
  return Array.isArray(o[k]) ? null : `field ${k} must be an array`;
}

function optString(o: Record<string, unknown>, k: string): string | null {
  return o[k] === undefined || typeof o[k] === 'string' ? null : `field ${k} must be a string if present`;
}

function optNonNegativeInt(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  if (v === undefined) return null;
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
    ? null
    : `field ${k} must be a non-negative integer if present`;
}

type PayloadCheck = (v: unknown) => string | null;

function checkConversationSummary(v: unknown): string | null {
  if (!isObj(v)) return 'conversation must be an object';
  return (
    reqPositiveInt(v, 'id') ??
    reqString(v, 'title') ??
    reqString(v, 'profileId') ??
    reqArray(v, 'tags') ??
    reqString(v, 'cwd') ??
    strAllowEmpty(v, 'model') ??
    (v.runtimeModelOverride === undefined || typeof v.runtimeModelOverride === 'boolean'
      ? null
      : 'field runtimeModelOverride must be a boolean if present') ??
    (['working', 'blocked', 'done', 'idle', 'error'].includes(String(v.status))
      ? null
      : 'field status must be one of working|blocked|done|idle|error') ??
    reqNonNegativeInt(v, 'stateChangeSeq') ??
    reqNonNegativeInt(v, 'completionSeq') ??
    (typeof v.unread === 'boolean' ? null : 'field unread must be a boolean') ??
    (typeof v.pinned === 'boolean' ? null : 'field pinned must be a boolean') ??
    reqNonNegativeInt(v, 'pendingAskCount') ??
    optNonNegativeInt(v, 'runDurationMs') ??
    optNonNegativeInt(v, 'runStartedAt') ??
    optNonNegativeInt(v, 'pendingAskSince') ??
    reqNonNegativeInt(v, 'createdAt') ??
    reqNonNegativeInt(v, 'updatedAt')
  );
}

function checkConversationAttachmentRef(v: unknown): string | null {
  if (!isObj(v)) return 'each item in field attachments must be a ConversationAttachmentRef object';
  return (
    (typeof v.id === 'string' && v.id.trim().length > 0 ? null : 'field attachment.id must be a non-empty string') ??
    reqString(v, 'name') ??
    reqString(v, 'mimeType') ??
    (typeof v.size === 'number' && Number.isSafeInteger(v.size) && v.size >= 0
      ? null
      : 'field attachment.size must be a non-negative safe integer')
  );
}

function checkConversationInput(v: unknown): string | null {
  if (!isObj(v)) return 'each input item must be ConversationInput';
  let err =
    reqString(v, 'id') ??
    strAllowEmpty(v, 'text') ??
    (typeof v.origin === 'string' && ['human', 'agent', 'trigger'].includes(v.origin)
      ? null
      : 'field origin must be human|agent|trigger') ??
    (v.whenBusy === undefined ||
    (typeof v.whenBusy === 'string' && ['steer', 'followUp', 'reject'].includes(v.whenBusy))
      ? null
      : 'field whenBusy must be steer|followUp|reject if present') ??
    (v.whenPendingAsk === undefined ||
    (typeof v.whenPendingAsk === 'string' && ['supersede', 'reject'].includes(v.whenPendingAsk))
      ? null
      : 'field whenPendingAsk must be supersede|reject if present') ??
    reqNonNegativeInt(v, 'createdAt') ??
    (v.meta === undefined || isObj(v.meta) ? null : 'field meta must be a plain object if present');
  if (err) return err;
  if (v.attachments !== undefined) {
    if (!Array.isArray(v.attachments)) return 'field attachments must be an array if present';
    for (const item of v.attachments as unknown[]) {
      if ((err = checkConversationAttachmentRef(item))) return err;
    }
  }
  return null;
}

const PAYLOAD_CHECKS: Record<HookName, PayloadCheck> = {
  input: (v) => {
    if (!isObj(v)) return 'must be an object';
    return reqPositiveInt(v, 'conversationId') ?? checkConversationInput(v.input);
  },
  before_turn: (v) => {
    if (!isObj(v)) return 'must be an object';
    let err =
      checkConversationSummary(v.conversation) ??
      reqArray(v, 'inputs') ??
      reqArray(v, 'tools') ??
      reqArray(v, 'sections') ??
      reqArray(v, 'messages');
    if (err) return err;
    for (const i of v.inputs as unknown[]) if ((err = checkConversationInput(i))) return err;
    for (const t of v.tools as unknown[]) {
      if (!isObj(t) || typeof t.name !== 'string' || typeof t.description !== 'string' || !isObj(t.inputSchema)) {
        return 'each item in field tools must be PluginToolSpec';
      }
    }
    for (const s of v.sections as unknown[]) {
      if (!isObj(s) || typeof s.id !== 'string' || typeof s.text !== 'string') {
        return 'each item in field sections must be { id: string; text: string }';
      }
    }
    for (const m of v.messages as unknown[]) {
      if (!isObj(m)) return 'each item in field messages must be an object';
    }
    return null;
  },
  agent_spawn: (v) => {
    if (!isObj(v)) return 'must be an AgentSpawnRequest object';
    return (
      reqPositiveInt(v, 'parentConversationId') ??
      reqString(v, 'prompt') ??
      optString(v, 'title') ??
      optString(v, 'agentId') ??
      optString(v, 'agentType') ??
      optString(v, 'model') ??
      optString(v, 'effort') ??
      optString(v, 'nodeId') ??
      optString(v, 'cwd') ??
      optString(v, 'gate') ??
      (v.gateTimeoutMs === undefined ||
      (typeof v.gateTimeoutMs === 'number' && Number.isSafeInteger(v.gateTimeoutMs) && v.gateTimeoutMs > 0)
        ? null
        : 'field gateTimeoutMs must be a positive safe integer if present') ??
      optString(v, 'resume') ??
      optString(v, 'requestId') ??
      (v.fork === undefined || typeof v.fork === 'boolean' ? null : 'field fork must be a boolean if present') ??
      (v.reattach === undefined || isObj(v.reattach) ? null : 'field reattach must be an object if present') ??
      (v.isolation === undefined || typeof v.isolation === 'string' ? null : 'field isolation must be a string if present') ??
      (v.schema === undefined || isObj(v.schema) ? null : 'field schema must be an object if present') ??
      (v.attachments === undefined ||
      (Array.isArray(v.attachments) && v.attachments.every((a) => typeof a === 'string' && a.trim().length > 0))
        ? null
        : 'field attachments must be a non-empty string array if present') ??
      (v.meta === undefined || isObj(v.meta) ? null : 'field meta must be a plain object if present') ??
      (v.onResolved === undefined || typeof v.onResolved === 'function' ? null : 'field onResolved must be a function if present') ??
      (v.onGateResult === undefined || typeof v.onGateResult === 'function' ? null : 'field onGateResult must be a function if present') ??
      (v.signal === undefined || v.signal instanceof AbortSignal ? null : 'field signal must be an AbortSignal if present')
    );
  },
  turn_settled: (v) => {
    if (!isObj(v)) return 'must be a TurnSettledPayload object';
    let err =
      checkConversationSummary(v.conversation) ?? reqArray(v, 'inputs') ?? optString(v, 'error') ?? reqNonNegativeInt(v, 'settledAt');
    if (err) return err;
    if (!['completed', 'failed', 'aborted'].includes(String(v.outcome))) {
      return 'field outcome must be completed|failed|aborted';
    }
    for (const i of v.inputs as unknown[]) if ((err = checkConversationInput(i))) return err;
    return null;
  },
};

/** Validates required fields of a hook payload (entry, post-transform, and default path). */
export function assertHookPayload(name: HookName, value: unknown): void {
  const err = PAYLOAD_CHECKS[name](value);
  if (err) {
    throw new HelmxError('invalid_hook_result', `Hook ${name} payload validation failed: ${err}`, 500, {
      hook: name,
      violation: err,
    });
  }
}

/** Isolated error captured during `turn_settled` pipeline execution (surfaced as notification by PluginHost). */
export interface IsolatedHookError {
  pluginId: string;
  error: HelmxError;
}

export class HookPipeline<K extends HookName> {
  private hooks: Array<RegisteredHook<K>> = [];
  private nextSeq = 0;
  private sorted = true;

  constructor(public readonly name: K) {}

  add(pluginId: string, handler: HookHandler<K>, priority = 0): void {
    this.hooks.push({ pluginId, priority, seq: this.nextSeq++, handler });
    this.sorted = false;
  }

  removeByPlugin(pluginId: string): void {
    this.hooks = this.hooks.filter((h) => h.pluginId !== pluginId);
  }

  get size(): number {
    return this.hooks.length;
  }

  entries(): Array<RegisteredHook<K>> {
    this.ensureSorted();
    // Snapshot-copy before iterating: handlers await arbitrary promises and concurrent add() resets `sorted=false`.
    return [...this.hooks];
  }

  private ensureSorted(): void {
    if (!this.sorted) {
      // V8 sort is stable: equal priorities keep registration order.
      this.hooks.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      this.sorted = true;
    }
  }

  /**
   * Executes the pipeline and returns the final payload, any short-circuit result, and isolated errors (`turn_settled`).
   * All non-`turn_settled` hooks throw loudly on errors/invalid shapes; `turn_settled` isolates per-plugin failures.
   */
  async run(
    payload: HookPayloadMap[K],
    isParticipant?: (hook: RegisteredHook<K>) => boolean,
  ): Promise<{
    finalPayload: HookPayloadMap[K];
    shortCircuit?: Extract<HookResult<unknown>, { action: 'handled' | 'block' }>;
    isolatedErrors?: IsolatedHookError[];
  }> {
    assertHookPayload(this.name, payload);
    const isolate = this.name === 'turn_settled';
    const isolatedErrors: IsolatedHookError[] = [];
    const isolateError = (hook: RegisteredHook<K>, err: unknown): void => {
      isolatedErrors.push({
        pluginId: hook.pluginId,
        error:
          err instanceof HelmxError
            ? err
            : new HelmxError(
                'hook_execution_failed',
                `Plugin ${hook.pluginId} ${this.name} hook threw an error: ${err instanceof Error ? err.message : String(err)}`,
                500,
                { pluginId: hook.pluginId, hook: this.name },
              ),
      });
    };
    let current = payload;
    for (const hook of this.entries()) {
      if (isParticipant && !isParticipant(hook)) continue;
      let result: HookResult<HookPayloadMap[K]> | void;
      try {
        result = await (hook.handler as (payload: HookPayloadMap[K]) => unknown)(current) as HookResult<HookPayloadMap[K]> | void;
      } catch (err) {
        if (!isolate) {
          if (err instanceof HelmxError) throw err;
          throw new HelmxError(
            'hook_execution_failed',
            `Plugin ${hook.pluginId} ${this.name} hook threw an error: ${err instanceof Error ? err.message : String(err)}`,
            500,
            { pluginId: hook.pluginId, hook: this.name },
          );
        }
        isolateError(hook, err);
        continue;
      }
      let normalized: Extract<HookResult<HookPayloadMap[K]>, { action: 'transform' | 'handled' | 'block' }> | undefined;
      try {
        normalized = this.normalizeResult(hook, result);
      } catch (err) {
        if (!isolate) throw err;
        isolateError(hook, err);
        continue;
      }
      if (normalized === undefined) continue;
      if (normalized.action === 'transform') {
        current = normalized.value as HookPayloadMap[K];
        continue;
      }
      return { finalPayload: current, shortCircuit: normalized };
    }
    return {
      finalPayload: current,
      ...(isolatedErrors.length > 0 ? { isolatedErrors } : {}),
    };
  }

  /** Normalizes a single handler result (shared by `run`/`runAround`); throws explicitly on invalid returns. */
  private normalizeResult(
    hook: RegisteredHook<K>,
    result: HookResult<HookPayloadMap[K]> | void,
  ): Extract<HookResult<HookPayloadMap[K]>, { action: 'transform' | 'handled' | 'block' }> | undefined {
    if (result === undefined || result === null) return undefined;
    const allowed = HOOK_ALLOWED_ACTIONS[this.name];
    if (!isObj(result) || typeof result.action !== 'string') {
      throw new HelmxError(
        'invalid_hook_result',
        `Plugin ${hook.pluginId} ${this.name} hook returned an invalid result (missing action field)`,
        500,
        { pluginId: hook.pluginId, hook: this.name, result },
      );
    }
    if (!allowed.has(result.action)) {
      throw new HelmxError(
        'invalid_hook_result',
        `Plugin ${hook.pluginId} ${this.name} hook returned unsupported action "${result.action}" (allowed: ${[...allowed].join('|')})`,
        500,
        { pluginId: hook.pluginId, hook: this.name, allowed: [...allowed] },
      );
    }
    if (result.action === 'continue') return undefined;
    if (result.action === 'transform') {
      if (result.value === undefined) {
        throw new HelmxError(
          'invalid_hook_result',
          `Plugin ${hook.pluginId} ${this.name} hook returned transform without value`,
          500,
          { pluginId: hook.pluginId, hook: this.name },
        );
      }
      assertHookPayload(this.name, result.value);
      return result;
    }
    if (result.action === 'block') {
      if (typeof result.reason !== 'string' || result.reason.length === 0) {
        throw new HelmxError(
          'invalid_hook_result',
          `Plugin ${hook.pluginId} ${this.name} hook returned block without a non-empty reason`,
          500,
          { pluginId: hook.pluginId, hook: this.name },
        );
      }
      return result;
    }
    return result; // handled
  }

  /**
   * Around (continuation) pipeline exclusively for `agent_spawn`.
   * Each handler receives `next(request)`; omitting `next` with `handled` short-circuits, while invoking
   * `next` runs the downstream chain + `defaultRun` at most once (duplicate `next()` or returning a second
   * non-`continue` action after `next()` throws `invalid_hook_result`).
   */
  async runAround(
    payload: HookPayloadMap[K],
    defaultRun: (finalPayload: HookPayloadMap[K]) => Promise<unknown>,
    isParticipant?: (hook: RegisteredHook<K>) => boolean,
  ): Promise<unknown> {
    if (this.name !== 'agent_spawn') {
      throw new HelmxError('invalid_hook_invocation', `runAround only applies to agent_spawn (received ${this.name})`, 500, {
        hook: this.name,
      });
    }
    assertHookPayload(this.name, payload);
    const hooks = this.entries().filter((h) => (isParticipant ? isParticipant(h) : true));

    const dispatchFrom = async (index: number, current: HookPayloadMap[K]): Promise<unknown> => {
      for (let i = index; i < hooks.length; i += 1) {
        const hook = hooks[i]!;
        let called = false;
        let nextPromise: Promise<unknown> | undefined;
        /** Controlled continuation: starts downstream chain once from index `i + 1` through `defaultRun`. */
        const next = (request: HookPayloadMap[K]): Promise<unknown> => {
          if (called) {
            throw new HelmxError(
              'invalid_hook_result',
              `Plugin ${hook.pluginId} agent_spawn hook cannot duplicate invoke next (continuation may run at most once)`,
              500,
              { pluginId: hook.pluginId, hook: this.name },
            );
          }
          called = true;
          const finalPayload = request === undefined || request === current ? current : request;
          if (finalPayload !== current) assertHookPayload(this.name, finalPayload);
          nextPromise = dispatchFrom(i + 1, finalPayload as HookPayloadMap[K]);
          return nextPromise;
        };
        let result: HookResult<HookPayloadMap[K]> | void;
        try {
          result = await (hook.handler as unknown as (
            payload: HookPayloadMap[K],
            next: (req: HookPayloadMap[K]) => Promise<unknown>,
          ) => unknown)(current, next as never) as HookResult<HookPayloadMap[K]> | void;
        } catch (err) {
          // Join background nextPromise before rethrowing handler error so downstream completes cleanly once.
          if (nextPromise !== undefined) await nextPromise.then(() => undefined, () => undefined);
          if (err instanceof HelmxError) throw err;
          throw new HelmxError(
            'hook_execution_failed',
            `Plugin ${hook.pluginId} ${this.name} hook threw an error: ${err instanceof Error ? err.message : String(err)}`,
            500,
            { pluginId: hook.pluginId, hook: this.name },
          );
        }
        if (nextPromise !== undefined) {
          // Once continuation runs, returning transform/handled conflicts with next()'s ownership; reject after joining.
          if (result !== undefined && result !== null && isObj(result) && result.action !== 'continue') {
            await nextPromise.then(() => undefined, () => undefined);
            throw new HelmxError(
              'invalid_hook_result',
              `Plugin ${hook.pluginId} agent_spawn hook already invoked next and must not again return "${String((result as { action?: unknown }).action)}"`,
              500,
              { pluginId: hook.pluginId, hook: this.name, result },
            );
          }
          return nextPromise;
        }
        const normalized = this.normalizeResult(hook, result);
        if (normalized === undefined) continue;
        if (normalized.action === 'transform') {
          current = normalized.value as HookPayloadMap[K];
          continue;
        }
        if (normalized.action === 'block') {
          throw new HelmxError(
            'hook_blocked',
            `Plugin ${hook.pluginId} agent_spawn hook blocked spawn: ${normalized.reason}`,
            403,
            { pluginId: hook.pluginId, hook: this.name, reason: normalized.reason },
          );
        }
        return normalized.result;
      }
      return defaultRun(current);
    };

    return dispatchFrom(0, payload);
  }
}

// Re-export concrete hook payload types for runtime and tests
export type {
  AgentSpawnRequest,
  BeforeTurnHookPayload,
  InputHookPayload,
  TurnSettledPayload,
};
