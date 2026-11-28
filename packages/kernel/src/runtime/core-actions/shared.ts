/**
 * Shared building blocks for every `core:*` domain module: strict-JSON normalization,
 * SemVer validation, and the core action registrar.
 *
 * Domain modules (`conversation.ts`, `profile.ts`, ...) depend on this module and the runtime
 * host only; nothing here knows about individual actions.
 */
import {
  isStrictSemver,
  stripSemverVPrefix,
  type PluginActionSpec,
} from '@helmx/protocol'
import { ValidationError } from '../../http/validate.js'
import { stripUndefinedProperties } from '../../shared/json.js'
import type { PluginHost } from '../../plugins/plugin-host.js'

/** Registration surface consumed by each domain module (keeps them independent of the full `PluginHost`). */
export type CoreActionRegistrar = Pick<PluginHost, 'registerCoreAction'>

export function requireStrictSemverField(raw: string): string {
  if (raw.trim() === '') {
    throw new ValidationError('targetVersion must be a non-empty version (omit to upgrade to latest)')
  }
  const bare = stripSemverVPrefix(raw)
  if (!isStrictSemver(bare)) {
    throw new ValidationError('targetVersion must be strict SemVer (optional single v prefix, e.g. 1.2.3 or v1.2.3)')
  }
  return raw
}

/**
 * Normalize kernel DTOs to strict JSON values by omitting object keys whose value is `undefined`
 * (matching HTTP `JSON.stringify` serialization so `CapabilityRegistry`'s strict `jsonClone` accepts
 * optional TypeScript fields like `parentConversationId: undefined` or `description: undefined`).
 */
export function toStrictJsonValue<T>(value: T): T {
  return stripUndefinedProperties(value, {
    onCycle: 'throw',
    cycleErrorMessage: 'Core action output contains a circular reference',
    objectFilter: 'all-objects',
  })
}

/** Register a single core action while normalizing returned kernel DTOs for strict JSON cloning. */
export function registerCore<TIn, TOut>(
  pluginHost: PluginHost,
  ownerId: string,
  spec: PluginActionSpec<TIn, TOut>,
): void {
  pluginHost.registerCoreAction<TIn, TOut>(ownerId, {
    ...spec,
    handler: async (input: TIn, context) => toStrictJsonValue(await spec.handler(input, context)),
  })
}
