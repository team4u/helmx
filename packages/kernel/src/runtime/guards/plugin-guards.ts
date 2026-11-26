/**
 * Plugin domain guards and target resolvers:
 *
 * Single source of truth shared by HTTP routes (`http/plugin-routes.ts`) and `core:plugins.*`
 * actions (`runtime/core-actions.ts`):
 * - Plugin config value redaction (`secret: true` fields masked to `'******'` / `''`, non-secret
 *   fields passed through `SecretStash` redaction when supplied);
 * - Sanitized config snapshot assembly (`{ values, schema, sources? }`);
 * - Doctor target resolution (`target` / `path` / `id` mutual exclusion + `assertDoctorTargetDir`).
 */
import {
  HelmxError,
  type PluginConfigFieldSchema,
  type PluginConfigFieldSource,
} from '@helmx/protocol'
import { assertDoctorTargetDir } from '../../plugins/doctor-target.js'
import { redactJsonValue } from '../../redact.js'

export interface PluginConfigReadHost {
  getConfig(pluginId: string): Record<string, unknown> | Promise<Record<string, unknown>>
  getConfigSchema(
    pluginId: string,
  ): Record<string, PluginConfigFieldSchema> | Promise<Record<string, PluginConfigFieldSchema>>
  getConfigSources?: (
    pluginId: string,
  ) => Record<string, PluginConfigFieldSource> | Promise<Record<string, PluginConfigFieldSource>>
}

export interface SanitizedPluginConfigSnapshot {
  readonly values: Record<string, unknown>
  readonly schema: Record<string, PluginConfigFieldSchema>
  readonly sources?: Record<string, PluginConfigFieldSource>
}

export interface PluginDoctorTargetInput {
  readonly target?: string
  readonly path?: string
  readonly id?: string
}

/**
 * Redacts plugin config values before leaving the server:
 * - Drops keys not declared in `schema`;
 * - Masks `secret: true` fields (`'******'` when non-empty string, `''` otherwise);
 * - Redacts non-secret values via `redactText` when provided (defense-in-depth with SecretStash).
 */
export function redactPluginConfigValues(
  raw: Record<string, unknown>,
  schema: Record<string, PluginConfigFieldSchema>,
  redactText?: (text: string) => string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(schema, key)) continue
    if (schema[key]?.secret === true) {
      out[key] = typeof value === 'string' && value.length > 0 ? '******' : ''
    } else {
      out[key] = redactText !== undefined ? redactJsonValue(value, redactText) : value
    }
  }
  return out
}

/** Read and sanitize a plugin's config snapshot (`values`, `schema`, optional `sources`). */
export async function readSanitizedPluginConfig(
  host: PluginConfigReadHost,
  pluginId: string,
  redactText?: (text: string) => string,
): Promise<SanitizedPluginConfigSnapshot> {
  const [raw, schema, sources] = await Promise.all([
    Promise.resolve(host.getConfig(pluginId)),
    Promise.resolve(host.getConfigSchema(pluginId)),
    Promise.resolve(host.getConfigSources !== undefined ? host.getConfigSources(pluginId) : undefined),
  ])
  const values = redactPluginConfigValues(raw, schema, redactText)
  return {
    values,
    schema,
    ...(sources !== undefined ? { sources } : {}),
  }
}

/** Heuristic classifier distinguishing a filesystem path target from a registered plugin ID. */
export function looksLikePluginPathTarget(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.startsWith('.') ||
    value.startsWith('~') ||
    /^[A-Za-z]:/.test(value) ||
    value.includes('/') ||
    value.includes('\\')
  )
}

/**
 * Single-source doctor target resolver shared by `POST /api/plugins/doctor` (`allowTarget: false`)
 * and `core:plugins.doctor` (`allowTarget: true`). Enforces mutual exclusion and validates path
 * targets with `assertDoctorTargetDir` before invoking `PluginHost.doctorExternalPlugin`.
 */
export function resolvePluginDoctorTarget(
  input: PluginDoctorTargetInput,
  options?: { allowTarget?: boolean },
): { dir: string } | { id: string } {
  const allowTarget = options?.allowTarget !== false
  if (!allowTarget && input.target !== undefined) {
    throw new HelmxError(
      'validation_error',
      'target is not supported here; provide either path (absolute directory path) or id (registered plugin)',
      400,
    )
  }
  const hasTarget = allowTarget && input.target !== undefined
  const hasPath = input.path !== undefined
  const hasId = input.id !== undefined
  const providedCount = (hasTarget ? 1 : 0) + (hasPath ? 1 : 0) + (hasId ? 1 : 0)
  if (providedCount === 0) {
    throw new HelmxError(
      'validation_error',
      allowTarget
        ? 'must provide one of target, path (absolute directory), or id (registered plugin)'
        : 'must provide either path (absolute directory path) or id (registered plugin)',
      400,
    )
  }
  if (providedCount > 1) {
    throw new HelmxError(
      'validation_error',
      allowTarget
        ? 'target, path, and id are mutually exclusive; provide only one'
        : 'id and path are mutually exclusive; provide only one',
      400,
    )
  }
  if (hasPath) {
    if (typeof input.path !== 'string' || input.path.trim() === '') {
      throw new HelmxError('validation_error', 'path must be a non-empty directory path', 400)
    }
    assertDoctorTargetDir(input.path, 'path')
    return { dir: input.path }
  }
  if (hasId) {
    if (typeof input.id !== 'string' || input.id.trim() === '') {
      throw new HelmxError('validation_error', 'id must be a non-empty registered plugin ID', 400)
    }
    return { id: input.id }
  }
  const target = input.target!
  if (typeof target !== 'string' || target.trim() === '') {
    throw new HelmxError('validation_error', 'target must be a non-empty directory path or plugin ID', 400)
  }
  if (looksLikePluginPathTarget(target)) {
    assertDoctorTargetDir(target, 'target')
    return { dir: target }
  }
  return { id: target }
}
