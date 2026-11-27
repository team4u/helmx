/** `core:skills`: human HTTP/CLI skill listing and bounded reference-file reading. */
import { HelmxError } from '@helmx/protocol'
import { isSafeRelativePath } from '../../http/validate.js'
import type { CoreActionsRuntimeHost } from '../runtime-types.js'
import {
  ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
  EMPTY_INPUT_SCHEMA,
  ID_STRING,
  NON_EMPTY_STRING,
  NO_CONVERSATION_SCOPE,
  type CoreActionRegistrar,
} from './shared.js'

export function registerSkillCoreActions(runtime: CoreActionsRuntimeHost, pluginHost: CoreActionRegistrar): void {
  const owner = 'core:skills'

  pluginHost.registerCoreAction(owner, {
    id: 'list',
    description: 'List installed skills (human HTTP/CLI only; agents use load_skill instead)',
    idempotent: true,
    scope: NO_CONVERSATION_SCOPE,
    exposeToPrompt: false,
    cli: { command: ['skills', 'list'] },
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
    handler: async () => runtime.skills.list(),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'read',
    description: 'Read a skill SKILL.md or relative reference file (human HTTP/CLI only; agents use load_skill instead)',
    idempotent: true,
    scope: NO_CONVERSATION_SCOPE,
    exposeToPrompt: false,
    cli: { command: ['skills', 'read'] },
    inputSchema: {
      type: 'object',
      properties: {
        id: ID_STRING,
        path: NON_EMPTY_STRING,
      },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    handler: async (input: { id: string; path?: string }) => {
      if (input.path !== undefined && !isSafeRelativePath(input.path)) {
        throw new HelmxError('path_traversal', `skill file path out of bounds: ${input.id}/${input.path}`, 400)
      }
      const text = await runtime.skills.readFile(input.id, input.path)
      return { text }
    },
  })
}
