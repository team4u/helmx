/**
 * Declarative Core Operation specifications for the `skills` domain.
 * Drives HTTP (`/api/skills*`), `core:skills.*` actions, and static `helmx skills *` CLI commands.
 */
import type { JsonSchema } from '../plugin-contract-types.js'
import {
  CORE_ARRAY_OUTPUT_SCHEMA,
  CORE_EMPTY_INPUT_SCHEMA,
  CORE_ID_SCHEMA,
  CORE_NO_CONVERSATION_SCOPE,
  type CoreOperationSpec,
} from './types.js'

const SKILL_SUMMARY_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    references: { type: 'array', items: { type: 'string' } },
    managedByPlugin: { type: 'string' },
    source: { type: 'string', enum: ['data', 'agents', 'node'] },
  },
  required: ['id', 'name', 'references'],
  additionalProperties: false,
}

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
      sharedCommand: true,
    },
    action: {
      idempotent: true,
      scope: CORE_NO_CONVERSATION_SCOPE,
      exposeToPrompt: false,
    },
  },
  {
    key: 'skills.catalog',
    domain: 'skills',
    id: 'catalog',
    description:
      'List merged skill catalog for an explicit target node and optional workspace cwd (Hub > Hub agents > node machine > workspace; human HTTP/CLI only)',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', minLength: 1 },
        cwd: { type: 'string', minLength: 1 },
      },
      required: ['nodeId'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        cwd: { type: 'string' },
        skills: { type: 'array', items: SKILL_SUMMARY_JSON_SCHEMA },
        shadowedNodeSkillIds: { type: 'array', items: { type: 'string' } },
        nodeUnavailable: { type: 'string' },
      },
      required: ['nodeId', 'skills', 'shadowedNodeSkillIds'],
      additionalProperties: false,
    },
    http: {
      method: 'GET',
      path: '/api/skills/scoped/catalog',
      queryParams: ['nodeId', 'cwd'],
      bodyMode: 'none',
    },
    cli: {
      command: ['skills', 'list'],
      sharedCommand: true,
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
    description:
      'Read a skill SKILL.md or relative reference file, optionally scoped to an explicit node and workspace cwd (human HTTP/CLI only; agents use load_skill instead)',
    inputSchema: {
      type: 'object',
      properties: {
        id: CORE_ID_SCHEMA,
        path: { type: 'string', minLength: 1 },
        nodeId: { type: 'string', minLength: 1 },
        cwd: { type: 'string', minLength: 1 },
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
      queryParams: ['path', 'nodeId', 'cwd'],
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
