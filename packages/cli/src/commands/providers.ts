/**
 * Model provider gateway and server-side credential commands: providers list/set, credentials list/set/delete.
 * Driven by `@helmx/protocol` `PROVIDER_CORE_OPERATIONS` and `CREDENTIAL_CORE_OPERATIONS` via `commandsFromOperations`.
 */
import {
  CREDENTIAL_CORE_OPERATIONS,
  PROVIDER_CORE_OPERATIONS,
  type ProviderConfig,
} from '@helmx/protocol'
import { flagValue } from '../args.js'
import { CliError } from '../errors.js'
import { commandsFromOperations } from './from-operations.js'
import type { CommandContext, CommandSpec } from './shared.js'
import {
  assertNoExtraPositionals,
  printResult,
  requireJsonInput,
  requirePositional,
  resolveSecretValue,
} from './shared.js'

const PROVIDER_AND_CREDENTIAL_OPERATIONS = [
  ...PROVIDER_CORE_OPERATIONS,
  ...CREDENTIAL_CORE_OPERATIONS,
] as const

export function providersCommands(): CommandSpec[] {
  return commandsFromOperations(PROVIDER_AND_CREDENTIAL_OPERATIONS, {
    customHandlers: {
      'providers set': {
        description:
          'Replace the full model provider list (PUT /api/providers; complete array, must not contain secrets)',
        flags: [{ name: 'input', type: 'json', required: true, help: 'ProviderConfig[] JSON array' }],
        async run(ctx: CommandContext) {
          assertNoExtraPositionals(ctx.positionals, 0)
          const input = requireJsonInput(ctx.flags)
          if (!Array.isArray(input)) {
            throw new CliError('--input must be a complete JSON array (ProviderConfig[])', 'invalid_flag_value')
          }
          const hub = await ctx.hub()
          printResult(ctx, await hub.put<ProviderConfig[]>('/api/providers', { providers: input }))
        },
      },
      'credentials set': {
        description:
          'Set a server-side credential (PUT /api/credentials/:id; write-only, plaintext cannot be read back)',
        flags: [
          {
            name: 'value',
            type: 'string',
            help: 'secret value (prompts masked in a TTY or reads from stdin when omitted)',
          },
        ],
        positional: '<id>',
        async run(ctx: CommandContext) {
          const id = requirePositional(ctx.positionals, 0, 'id')
          assertNoExtraPositionals(ctx.positionals, 1)
          const value = await resolveSecretValue(ctx, flagValue<string>(ctx.flags, 'value'), {
            flagName: 'value',
            prompt: `Credential value for ${id}: `,
            missingCode: 'missing_required_flag',
          })
          const hub = await ctx.hub()
          printResult(ctx, await hub.put<unknown>(`/api/credentials/${encodeURIComponent(id)}`, { value }))
        },
      },
    },
  })
}
