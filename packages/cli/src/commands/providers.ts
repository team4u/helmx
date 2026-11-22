/** Model provider gateway and server-side credential commands: providers list/set, credentials list/set/delete. */
import type { CredentialSummary, ProviderConfig } from '@helmx/protocol'
import { CliError } from '../errors.js'
import { flagValue, parseFlags } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { assertNoExtraPositionals, parseNoFlags, printResult, requireJsonInput, requirePositional, resolveSecretValue } from './shared.js'

export function providersCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['providers', 'list'],
    description: 'List model providers (GET /api/providers)',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<ProviderConfig[]>('/api/providers'))
    },
  })

  cmds.push({
    path: ['providers', 'set'],
    description: 'Replace the full model provider list (PUT /api/providers; complete array, must not contain secrets)',
    flags: [{ name: 'input', type: 'json', required: true, help: 'ProviderConfig[] JSON array' }],
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'input', type: 'json', required: true }], ctx.args)
      assertNoExtraPositionals(parsed.positionals, 0)
      const input = requireJsonInput(parsed.flags)
      if (!Array.isArray(input)) throw new CliError('--input must be a complete JSON array (ProviderConfig[])', 'invalid_flag_value')
      const hub = await ctx.hub()
      printResult(ctx, await hub.put<ProviderConfig[]>('/api/providers', { providers: input }))
    },
  })

  cmds.push({
    path: ['credentials', 'list'],
    description: 'List server-side credentials (GET /api/credentials; returns keys and configured flags only)',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<CredentialSummary[]>('/api/credentials'))
    },
  })

  cmds.push({
    path: ['credentials', 'set'],
    description: 'Set a server-side credential (PUT /api/credentials/:id; write-only, plaintext cannot be read back)',
    flags: [{ name: 'value', type: 'string', help: 'secret value (prompts masked in a TTY or reads from stdin when omitted)' }],
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'value', type: 'string' }], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      assertNoExtraPositionals(parsed.positionals, 1)
      const value = await resolveSecretValue(ctx, flagValue<string>(parsed.flags, 'value'), {
        flagName: 'value',
        prompt: `Credential value for ${id}: `,
        missingCode: 'missing_required_flag',
      })
      const hub = await ctx.hub()
      printResult(ctx, await hub.put<unknown>(`/api/credentials/${encodeURIComponent(id)}`, { value }))
    },
  })

  cmds.push({
    path: ['credentials', 'delete'],
    description: 'Delete a server-side credential (DELETE /api/credentials/:id)',
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      assertNoExtraPositionals(parsed.positionals, 1)
      const hub = await ctx.hub()
      printResult(ctx, await hub.delete<unknown>(`/api/credentials/${encodeURIComponent(id)}`))
    },
  })

  return cmds
}
