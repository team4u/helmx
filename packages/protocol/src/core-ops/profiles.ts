/**
 * Declarative Core Operation specifications for the `profiles` domain.
 * Drives HTTP (`/api/profiles*`), `core:profiles.*` actions, and static `helmx profiles *` CLI commands.
 */
import { REQUEST_SCHEMAS } from '../request-schemas.js'
import {
  CORE_ARRAY_OUTPUT_SCHEMA,
  CORE_EMPTY_INPUT_SCHEMA,
  CORE_ID_SCHEMA,
  CORE_OBJECT_OUTPUT_SCHEMA,
  CORE_OK_OUTPUT_SCHEMA,
  cloneProtocolJsonSchema,
  extendCoreObjectSchema,
  type CoreOperationSpec,
} from './types.js'

export const PROFILE_CORE_OPERATIONS = [
  {
    key: 'profiles.list',
    domain: 'profiles',
    id: 'list',
    description: 'List all configured Profiles (summary metadata without SYSTEM.md body)',
    inputSchema: CORE_EMPTY_INPUT_SCHEMA,
    outputSchema: CORE_ARRAY_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/profiles',
      bodyMode: 'none',
      methodNotAllowed: true,
    },
    cli: {
      command: ['profiles', 'list'],
    },
    action: {
      idempotent: true,
      exposeToPrompt: false,
    },
  },
  {
    key: 'profiles.get',
    domain: 'profiles',
    id: 'get',
    description: 'Get a Profile by ID including its full SYSTEM.md text',
    inputSchema: {
      type: 'object',
      properties: { id: CORE_ID_SCHEMA },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/profiles/:id',
      pathParams: { id: 'id' },
      pathValidators: { id: 'id' },
      bodyMode: 'none',
      methodNotAllowed: true,
    },
    cli: {
      command: ['profiles', 'get'],
      positional: [{ field: 'id', required: true }],
    },
    action: {
      idempotent: true,
      exposeToPrompt: false,
    },
  },
  {
    key: 'profiles.create',
    domain: 'profiles',
    id: 'create',
    description: 'Create a new Profile (rejects managedByPlugin spoofing and disabled models)',
    inputSchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.profileCreate),
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/profiles',
      status: 201,
      bodyMode: 'required',
      methodNotAllowed: true,
    },
    cli: {
      command: ['profiles', 'create'],
      description: 'Create a Profile (POST /api/profiles; semantic flags or --input)',
      positional: [{ field: 'id', required: false }],
      flagAliases: { nodeId: 'node', thinkingLevel: 'thinking' },
    },
    action: {
      exposeToPrompt: false,
    },
  },
  {
    key: 'profiles.update',
    domain: 'profiles',
    id: 'update',
    description:
      'Partially update an existing Profile (merges provided fields onto current config; managedByPlugin is immutable)',
    // HTTP PUT binds `:id` to `profileId` so optional `body.id` remains validated by `bodySchema` and checked against `profileId`.
    inputSchema: extendCoreObjectSchema(
      REQUEST_SCHEMAS.profileUpdate,
      { profileId: CORE_ID_SCHEMA },
      ['profileId'],
    ),
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'PUT',
      path: '/api/profiles/:id',
      pathParams: { id: 'profileId' },
      pathValidators: { id: 'id' },
      bodyMode: 'required',
      bodySchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.profileUpdate),
      methodNotAllowed: true,
    },
    cli: {
      command: ['profiles', 'update'],
      description:
        'Update a Profile (PUT /api/profiles/:id full replacement; semantic flags auto-GET and merge to preserve untouched fields, --input alone replaces in full)',
      positional: [{ field: 'id', required: true }],
      flagAliases: { nodeId: 'node', thinkingLevel: 'thinking' },
    },
    action: {
      exposeToPrompt: false,
      inputSchema: extendCoreObjectSchema(REQUEST_SCHEMAS.profileUpdate, { id: CORE_ID_SCHEMA }, ['id']),
    },
  },
  {
    key: 'profiles.delete',
    domain: 'profiles',
    id: 'delete',
    description: 'Delete an unused, non-managed Profile by ID',
    inputSchema: {
      type: 'object',
      properties: { id: CORE_ID_SCHEMA },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: CORE_OK_OUTPUT_SCHEMA,
    http: {
      method: 'DELETE',
      path: '/api/profiles/:id',
      pathParams: { id: 'id' },
      pathValidators: { id: 'id' },
      bodyMode: 'none',
      methodNotAllowed: true,
    },
    cli: {
      command: ['profiles', 'delete'],
      positional: [{ field: 'id', required: true }],
    },
    action: {
      exposeToPrompt: false,
    },
  },
] as const satisfies readonly CoreOperationSpec[]

export type ProfileCoreOperation = (typeof PROFILE_CORE_OPERATIONS)[number]
export type ProfileCoreOperationKey = ProfileCoreOperation['key']
