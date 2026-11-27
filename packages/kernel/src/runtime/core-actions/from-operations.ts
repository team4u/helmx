/**
 * Generic `core:*` action registrar driven by `CoreOperationSpec[]`.
 *
 * Filters out operations where `spec.action === false`, preserves declared operation order,
 * binds `core:<domain>` ownership and `spec.action.inputSchema ?? spec.inputSchema`, and
 * enforces compile-time mapped-type exhaustiveness over actionable operation keys.
 */
import type {
  CoreActionOperationKey,
  CoreOperationActionSpec,
  CoreOperationSpec,
  PluginActionContext,
} from '@helmx/protocol'
import type { CoreActionRegistrar } from './shared.js'

export type CoreActionOperationHandlerFn<TIn = Record<string, unknown>, TOut = unknown> = (
  input: TIn,
  context: PluginActionContext,
) => Promise<TOut> | TOut

export interface CoreActionOperationEntry<TIn = Record<string, unknown>, TOut = unknown> {
  readonly handler: CoreActionOperationHandlerFn<TIn, TOut>
}

export type CoreActionOperationHandlers<TOps extends readonly CoreOperationSpec[]> = {
  readonly [K in CoreActionOperationKey<TOps>]:
    | CoreActionOperationEntry
    | CoreActionOperationHandlerFn
}

function isActionableSpec(
  spec: CoreOperationSpec,
): spec is CoreOperationSpec & { readonly action: CoreOperationActionSpec } {
  return spec.action !== false
}

/** Register all actionable `CoreOperationSpec` entries onto `pluginHost` via `registerCoreAction`. */
export function registerCoreActionsFromOperations<const TOps extends readonly CoreOperationSpec[]>(
  pluginHost: CoreActionRegistrar,
  operations: TOps,
  handlers: CoreActionOperationHandlers<TOps>,
): void {
  const handlerRecord = handlers as Record<
    string,
    CoreActionOperationEntry | CoreActionOperationHandlerFn
  >
  for (const spec of operations) {
    if (!isActionableSpec(spec)) continue
    const entry = handlerRecord[spec.key]
    if (entry === undefined) {
      throw new Error(`Missing core action handler for operation ${spec.key}`)
    }
    const handler = typeof entry === 'function' ? entry : entry.handler
    const actionSpec = spec.action
    pluginHost.registerCoreAction(`core:${spec.domain}`, {
      id: spec.id,
      description: spec.description,
      exposeToPrompt: actionSpec.exposeToPrompt ?? false,
      ...(actionSpec.idempotent !== undefined ? { idempotent: actionSpec.idempotent } : {}),
      ...(actionSpec.scope !== undefined ? { scope: actionSpec.scope } : {}),
      ...(actionSpec.visibility !== undefined ? { visibility: actionSpec.visibility } : {}),
      cli: { command: [...spec.cli.command] },
      inputSchema: actionSpec.inputSchema ?? spec.inputSchema,
      outputSchema: spec.outputSchema,
      handler: handler as (input: unknown, context: PluginActionContext) => Promise<unknown>,
    })
  }
}
