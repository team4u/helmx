/**
 * Generic static core CLI command builder driven by `CoreOperationSpec[]` at compile time.
 *
 * Zero network fetch and 100% fault-isolated from dynamic plugin manifests (`actions.ts`):
 * supports `flagAliases`, `positional` (with optional custom coercion hooks), `timeoutMs`,
 * REST `:param` + query (with alias mapping) interpolation, `--json` raw passthrough,
 * optional `formatHuman` hooks, deduplicated `extraFlags` overrides, and `customHandlers`
 * for composite commands (e.g. `nodes upgrade`).
 */
import type {
  CoreOperationHttpSpec,
  CoreOperationKey,
  CoreOperationPositionalSpec,
  CoreOperationSpec,
} from '@helmx/protocol'
import type { FlagSpec } from '../args.js'
import { CliError } from '../errors.js'
import {
  coercePositionalValue,
  flagsFromSchema,
  schemaPropertiesOf,
  schemaPropertyNames,
} from '../schema-flags.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { assertNoExtraPositionals, printResult, requirePositional } from './shared.js'

export type CoreCliFormatHuman<TInput = Record<string, unknown>, TResult = unknown> = (
  ctx: CommandContext,
  result: TResult,
  input: TInput,
) => void

export type CoreCliValidateInput<TInput = Record<string, unknown>> = (
  input: TInput,
  ctx: CommandContext,
) => TInput | void

export type CoreCliValidateResponse<TResult = unknown, TInput = Record<string, unknown>> = (
  result: TResult,
  input: TInput,
  ctx: CommandContext,
) => void

export type CoreCliCoercePositional = (
  raw: string,
  pos: CoreOperationPositionalSpec,
  ctx: CommandContext,
) => unknown

export interface CoreCliCustomCommandHandler {
  readonly description?: string
  readonly flags?: readonly FlagSpec[]
  readonly positional?: string
  readonly run: (ctx: CommandContext) => Promise<void | number>
}

export interface CommandsFromOperationsOptions<TOps extends readonly CoreOperationSpec[]> {
  /** Optional human-mode renderers keyed by `spec.key` (defaults to `printResult`). */
  readonly formatHuman?: Partial<Record<CoreOperationKey<TOps>, CoreCliFormatHuman>>
  /** Optional client-side validation/normalization before HTTP request, keyed by `spec.key`. */
  readonly validateInput?: Partial<Record<CoreOperationKey<TOps>, CoreCliValidateInput>>
  /** Optional HTTP response shape check after request, keyed by `spec.key`. */
  readonly validateResponse?: Partial<Record<CoreOperationKey<TOps>, CoreCliValidateResponse>>
  /** Optional extra CLI flags appended to or overriding schema-derived flags, keyed by `spec.key`. */
  readonly extraFlags?: Partial<Record<CoreOperationKey<TOps>, readonly FlagSpec[]>>
  /** Optional per-operation positional coercion overrides keyed by `spec.key` -> `pos.field`. */
  readonly coercePositionals?: Partial<
    Record<CoreOperationKey<TOps>, Readonly<Record<string, CoreCliCoercePositional>>>
  >
  /** Custom composite command handlers keyed by joined CLI command path (e.g. `'nodes upgrade'`). */
  readonly customHandlers?: Readonly<Record<string, CoreCliCustomCommandHandler>>
  /** Non-JSON / standalone domain commands appended cleanly alongside generated operations. */
  readonly extraCommands?: readonly CommandSpec[]
}

/**
 * Derive non-positional CLI flags for a single `CoreOperationSpec` using shared `schema-flags.ts` rules
 * (`flagAliases` + omitting positional-bound fields). Useful when composite `customHandlers`
 * extend schema-derived flags with CLI-only options like `--check` or `--current`.
 */
export function schemaFlagsForOperation(
  spec: CoreOperationSpec,
  extraOmitFields: readonly string[] = [],
): FlagSpec[] {
  const omitFields = new Set<string>([
    ...(spec.cli.positional ?? []).map((p) => p.field),
    ...extraOmitFields,
  ])
  return flagsFromSchema(spec.inputSchema, {
    ...(spec.cli.flagAliases !== undefined ? { aliases: spec.cli.flagAliases } : {}),
    omitFields,
  }).flags
}

function formatPositionalSynopsis(
  positionals: readonly CoreOperationPositionalSpec[] | undefined,
): string | undefined {
  if (!positionals || positionals.length === 0) return undefined
  return positionals
    .map((p) => {
      const label = p.label ?? p.field
      return p.required === true ? `<${label}>` : `[${label}]`
    })
    .join(' ')
}

function normalizeQueryEntries(
  queryParams: CoreOperationHttpSpec['queryParams'],
): Array<readonly [queryKey: string, fieldName: string]> {
  if (!queryParams) return []
  if (Array.isArray(queryParams)) {
    return (queryParams as readonly string[]).map((name) => [name, name] as const)
  }
  return Object.entries(queryParams as Readonly<Record<string, string>>)
}

function mergeFlagsWithOverrides(
  schemaFlags: readonly FlagSpec[],
  extraFlags: readonly FlagSpec[],
): { flags: FlagSpec[]; overriddenNames: Set<string> } {
  if (extraFlags.length === 0) {
    return { flags: [...schemaFlags], overriddenNames: new Set() }
  }
  const byName = new Map(extraFlags.map((f) => [f.name, f] as const))
  const overriddenNames = new Set<string>()
  const merged: FlagSpec[] = schemaFlags.map((flag) => {
    const override = byName.get(flag.name)
    if (override !== undefined) {
      overriddenNames.add(flag.name)
      byName.delete(flag.name)
      return override
    }
    return flag
  })
  for (const flag of byName.values()) {
    merged.push(flag)
  }
  return { flags: merged, overriddenNames }
}

function resolveHttpRequestTarget(
  spec: CoreOperationSpec,
  input: Record<string, unknown>,
): { path: string; body: Record<string, unknown> | undefined } {
  const consumedFields = new Set<string>()
  const path = spec.http.path.replace(/:([A-Za-z0-9_]+)/g, (_match, paramName: string) => {
    const fieldName = spec.http.pathParams?.[paramName] ?? paramName
    const value = input[fieldName]
    if (value === undefined) {
      throw new CliError(`missing required path parameter ${fieldName}`, 'missing_id')
    }
    consumedFields.add(fieldName)
    return encodeURIComponent(String(value))
  })

  const query = new URLSearchParams()
  for (const [queryKey, fieldName] of normalizeQueryEntries(spec.http.queryParams)) {
    const value = input[fieldName]
    if (value !== undefined) {
      query.set(queryKey, String(value))
    }
    consumedFields.add(fieldName)
  }
  const queryText = query.toString()
  const fullPath = queryText.length > 0 ? `${path}?${queryText}` : path

  const bodyMode =
    spec.http.bodyMode ?? (spec.http.method === 'GET' || spec.http.method === 'DELETE' ? 'none' : 'required')
  if (bodyMode === 'none') {
    return { path: fullPath, body: undefined }
  }

  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!consumedFields.has(key) && value !== undefined) {
      body[key] = value
    }
  }
  if (Object.keys(body).length === 0 && bodyMode === 'optional') {
    return { path: fullPath, body: undefined }
  }
  return { path: fullPath, body }
}

function buildStandardCommand(
  spec: CoreOperationSpec,
  options: CommandsFromOperationsOptions<readonly CoreOperationSpec[]>,
): CommandSpec {
  const positionals = spec.cli.positional ?? []
  const omitFields = new Set(positionals.map((p) => p.field))
  const flagOptions = {
    ...(spec.cli.flagAliases !== undefined ? { aliases: spec.cli.flagAliases } : {}),
    omitFields,
  }
  const { flags: schemaFlags } = flagsFromSchema(spec.inputSchema, flagOptions)
  const propertyNames = schemaPropertyNames(spec.inputSchema, flagOptions)
  const properties = schemaPropertiesOf(spec.inputSchema) ?? {}
  const extraFlags = options.extraFlags?.[spec.key] ?? []
  const { flags, overriddenNames } = mergeFlagsWithOverrides(schemaFlags, extraFlags)
  const positionalSynopsis = formatPositionalSynopsis(spec.cli.positional)

  return {
    path: [...spec.cli.command],
    description: `${spec.cli.description ?? spec.description} (${spec.http.method} ${spec.http.path})`,
    ...(flags.length > 0 ? { flags } : {}),
    ...(positionalSynopsis !== undefined ? { positional: positionalSynopsis } : {}),
    async run(ctx: CommandContext) {
      const input: Record<string, unknown> = {}
      for (const [flagName, value] of ctx.flags) {
        // Overridden flags (e.g. changing array flag from JSON to CSV string) are converted explicitly by validateInput.
        if (overriddenNames.has(flagName)) continue
        const propName = propertyNames.get(flagName)
        if (propName !== undefined) {
          input[propName] = value
        }
      }
      const positionalCoercers = options.coercePositionals?.[spec.key]
      for (const [index, pos] of positionals.entries()) {
        const raw = ctx.positionals[index]
        const label = pos.label ?? pos.field
        if (raw === undefined) {
          if (pos.required === true && input[pos.field] === undefined) {
            requirePositional(ctx.positionals, index, label, 'missing_id')
          }
          continue
        }
        const customCoerce = positionalCoercers?.[pos.field]
        const coerced = customCoerce
          ? customCoerce(raw, pos, ctx)
          : coercePositionalValue(raw, label, properties[pos.field])
        if (input[pos.field] !== undefined) {
          throw new CliError(
            `field "${pos.field}" specified by both flag and positional <${label}>: provide only one`,
            'conflicting_positional',
          )
        }
        input[pos.field] = coerced
      }
      assertNoExtraPositionals(ctx.positionals, positionals.length)

      const validator = options.validateInput?.[spec.key]
      const validatedInput = validator ? (validator(input, ctx) ?? input) : input
      const { path, body } = resolveHttpRequestTarget(spec, validatedInput)
      const hub = await ctx.hub()
      const result = await hub.request<unknown>(spec.http.method, path, {
        ...(body !== undefined ? { body } : {}),
        ...(spec.cli.timeoutMs !== undefined ? { timeoutMs: spec.cli.timeoutMs } : {}),
      })

      options.validateResponse?.[spec.key]?.(result, validatedInput, ctx)
      if (ctx.json) {
        printResult(ctx, result)
        return
      }
      const human = options.formatHuman?.[spec.key]
      if (human !== undefined) {
        human(ctx, result, validatedInput)
      } else {
        printResult(ctx, result)
      }
    },
  }
}

/**
 * Compile static CLI `CommandSpec[]` directly from `CoreOperationSpec[]`.
 * Operations marking `cli.sharedCommand: true` coalesce onto a single entry from `customHandlers`.
 */
export function commandsFromOperations<const TOps extends readonly CoreOperationSpec[]>(
  operations: TOps,
  options: CommandsFromOperationsOptions<TOps> = {},
): CommandSpec[] {
  const commands: CommandSpec[] = []
  const seenSharedCommands = new Set<string>()
  const opts = options as unknown as CommandsFromOperationsOptions<readonly CoreOperationSpec[]>

  for (const spec of operations) {
    const cmdPath = spec.cli.command.join(' ')
    const custom = opts.customHandlers?.[cmdPath]

    if (spec.cli.sharedCommand === true) {
      if (seenSharedCommands.has(cmdPath)) continue
      seenSharedCommands.add(cmdPath)
      if (custom === undefined) {
        throw new CliError(
          `shared core CLI command "helmx ${cmdPath}" requires an entry in customHandlers`,
          'command_table_conflict',
        )
      }
      commands.push({
        path: [...spec.cli.command],
        description: custom.description ?? spec.cli.description ?? spec.description,
        ...(custom.flags !== undefined ? { flags: custom.flags } : {}),
        ...(custom.positional !== undefined ? { positional: custom.positional } : {}),
        run: custom.run,
      })
      continue
    }

    if (custom !== undefined) {
      const derivedFlags = custom.flags ?? schemaFlagsForOperation(spec)
      const derivedPositional = custom.positional ?? formatPositionalSynopsis(spec.cli.positional)
      commands.push({
        path: [...spec.cli.command],
        description: custom.description ?? spec.cli.description ?? spec.description,
        ...(derivedFlags.length > 0 ? { flags: derivedFlags } : {}),
        ...(derivedPositional !== undefined ? { positional: derivedPositional } : {}),
        run: custom.run,
      })
      continue
    }

    commands.push(buildStandardCommand(spec, opts))
  }

  if (options.extraCommands) {
    commands.push(...options.extraCommands)
  }

  return commands
}
