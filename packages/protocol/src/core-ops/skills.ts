/**
 * Declarative Core Operation specifications for the `skills` domain.
 * Drives HTTP (`/api/skills*`), `core:skills.*` actions, and static `helmx skills *` CLI commands.
 */
import {
  CORE_ARRAY_OUTPUT_SCHEMA,
  CORE_EMPTY_INPUT_SCHEMA,
  CORE_ID_SCHEMA,
  CORE_NO_CONVERSATION_SCOPE,
  type CoreOperationSpec,
} from './types.js'

export const SKILL_CORE_OPERATIONS = [
  {
    key: 'skills.list',
    domain: 'skills',
    id: 'list',
    description: 'List installed skills (human HTTP/CLI only; agents use load_skill instead)',
    inputSchema: CORE_EMPTY_INPUT_SCHEMA,
    outputSchema: CORE_ARRAY_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/skills',
      bodyMode: 'none',
    },
    cli: {
      command: ['skills', 'list'],
    },
    action: {
      idempotent: true,
      scope: CORE_NO_CONVERSATION_SCOPE,
      exposeToPrompt: false,
    },
  },
  {
    key: 'skills.read',
    domain: 'skills',
    id: 'read',
    description: 'Read a skill SKILL.md or relative reference file (human HTTP/CLI only; agents use load_skill instead)',
    inputSchema: {
      type: 'object',
      properties: {
        id: CORE_ID_SCHEMA,
        path: { type: 'string', minLength: 1 },
      },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    http: {
      method: 'GET',
      path: '/api/skills/:id',
      pathParams: { id: 'id' },
      pathValidators: { id: 'id' },
      queryParams: ['path'],
      bodyMode: 'none',
    },
    cli: {
      command: ['skills', 'read'],
      positional: [{ field: 'id', required: true, label: 'id' }],
    },
    action: {
      idempotent: true,
      scope: CORE_NO_CONVERSATION_SCOPE,
      exposeToPrompt: false,
    },
  },
] as const satisfies readonly CoreOperationSpec[]

export type SkillCoreOperation = (typeof SKILL_CORE_OPERATIONS)[number]
export type SkillCoreOperationKey = SkillCoreOperation['key']
