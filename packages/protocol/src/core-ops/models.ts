/**
 * Declarative Core Operation specifications for `models`, `providers`, and `credentials` domains.
 *
 * SECURITY RED LINE: `providers.*` and `credentials.*` keep `action: false` so model/plugin turns
 * can never overwrite gateway endpoints or write/delete plaintext credentials via `core:*` actions.
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

export const MODEL_CORE_OPERATIONS = [
  {
    key: 'models.list',
    domain: 'models',
    id: 'list',
    description: 'List the available model catalog, thinking levels, and current defaults',
    inputSchema: CORE_EMPTY_INPUT_SCHEMA,
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/models',
      bodyMode: 'none',
    },
    cli: {
      command: ['models', 'list'],
    },
    action: {
      idempotent: true,
      exposeToPrompt: false,
    },
  },
  {
    key: 'models.providers',
    domain: 'models',
    id: 'providers',
    description: 'List sanitized model provider summaries (never exposes plaintext API keys or tokens)',
    inputSchema: CORE_EMPTY_INPUT_SCHEMA,
    outputSchema: CORE_ARRAY_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/models/providers',
      bodyMode: 'none',
    },
    cli: {
      command: ['models', 'providers'],
    },
    action: {
      idempotent: true,
      exposeToPrompt: false,
    },
  },
  {
    key: 'models.refresh',
    domain: 'models',
    id: 'refresh',
    description: 'Refresh dynamic model catalogs for all or specified providers',
    inputSchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.modelsRefresh),
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/models/refresh',
      bodyMode: 'optional',
    },
    cli: {
      command: ['models', 'refresh'],
      description: 'Refresh dynamic model catalog (POST /api/models/refresh; supports --provider, --providers, --force)',
    },
    action: {
      exposeToPrompt: false,
    },
  },
  {
    key: 'models.default_get',
    domain: 'models',
    id: 'default_get',
    description: 'Get global default model, thinking level, compaction defaults, and per-model thinking defaults',
    inputSchema: CORE_EMPTY_INPUT_SCHEMA,
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/models/default',
      bodyMode: 'none',
    },
    cli: {
      command: ['models', 'default'],
      sharedCommand: true,
    },
    action: {
      idempotent: true,
      exposeToPrompt: false,
    },
  },
  {
    key: 'models.default',
    domain: 'models',
    id: 'default',
    description: 'Set global default model, thinking level, compaction defaults, or per-model thinking defaults',
    inputSchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.modelsDefaultPut),
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'PUT',
      path: '/api/models/default',
      bodyMode: 'optional',
    },
    cli: {
      command: ['models', 'default'],
      description:
        'View or set global default model, per-model thinking defaults, and compaction model (GET/PUT /api/models/default)',
      flagAliases: {
        model: 'set',
        thinkingLevel: 'thinking',
        compactionModel: 'compaction',
        compactionThinkingLevel: 'compaction-thinking',
        modelThinkingLevel: 'model-thinking',
      },
      sharedCommand: true,
    },
    action: {
      exposeToPrompt: false,
    },
  },
  {
    key: 'models.filter',
    domain: 'models',
    id: 'filter',
    description: 'Set disabled models for a provider or clear all disabled model filters',
    inputSchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.modelsFilterPut),
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'PUT',
      path: '/api/models/filter',
      bodyMode: 'optional',
    },
    cli: {
      command: ['models', 'filter'],
      description: 'View or set disabled models (GET/PUT /api/models/filter)',
      flagAliases: { disabledModels: 'disable' },
      sharedCommand: true,
    },
    action: {
      exposeToPrompt: false,
    },
  },
] as const satisfies readonly CoreOperationSpec[]

export const PROVIDER_CORE_OPERATIONS = [
  {
    key: 'providers.list',
    domain: 'providers',
    id: 'list',
    description: 'List configured custom model providers',
    inputSchema: CORE_EMPTY_INPUT_SCHEMA,
    outputSchema: CORE_ARRAY_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/providers',
      bodyMode: 'none',
      methodNotAllowed: true,
    },
    cli: {
      command: ['providers', 'list'],
    },
    // SECURITY: gateway management is human HTTP/CLI only.
    action: false,
  },
  {
    key: 'providers.set',
    domain: 'providers',
    id: 'set',
    description: 'Replace the full model provider list (complete array, must not contain secrets)',
    inputSchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.providersPut),
    outputSchema: CORE_ARRAY_OUTPUT_SCHEMA,
    http: {
      method: 'PUT',
      path: '/api/providers',
      bodyMode: 'required',
      methodNotAllowed: true,
    },
    cli: {
      command: ['providers', 'set'],
      description: 'Replace the full model provider list (PUT /api/providers; complete array, must not contain secrets)',
      flagAliases: { providers: 'input' },
    },
    // SECURITY: providers.set must NEVER be exposed as `core:providers.set`.
    action: false,
  },
] as const satisfies readonly CoreOperationSpec[]

export const CREDENTIAL_CORE_OPERATIONS = [
  {
    key: 'credentials.list',
    domain: 'credentials',
    id: 'list',
    description: 'List server-side credentials (returns keys and configured flags only)',
    inputSchema: CORE_EMPTY_INPUT_SCHEMA,
    outputSchema: CORE_ARRAY_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/credentials',
      bodyMode: 'none',
    },
    cli: {
      command: ['credentials', 'list'],
    },
    // SECURITY: credentials namespace must NEVER be exposed as `core:*` actions.
    action: false,
  },
  {
    key: 'credentials.set',
    domain: 'credentials',
    id: 'set',
    description: 'Set a server-side credential (write-only, plaintext cannot be read back)',
    inputSchema: extendCoreObjectSchema(REQUEST_SCHEMAS.credentialPut, { id: CORE_ID_SCHEMA }, ['id']),
    outputSchema: CORE_OK_OUTPUT_SCHEMA,
    http: {
      method: 'PUT',
      path: '/api/credentials/:id',
      pathParams: { id: 'id' },
      pathValidators: { id: 'id' },
      bodyMode: 'required',
      bodySchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.credentialPut),
    },
    cli: {
      command: ['credentials', 'set'],
      description: 'Set a server-side credential (PUT /api/credentials/:id; write-only, plaintext cannot be read back)',
      positional: [{ field: 'id', required: true }],
    },
    // SECURITY: credentials.set must NEVER be exposed as `core:credentials.set`.
    action: false,
  },
  {
    key: 'credentials.delete',
    domain: 'credentials',
    id: 'delete',
    description: 'Delete a server-side credential',
    inputSchema: {
      type: 'object',
      properties: { id: CORE_ID_SCHEMA },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: CORE_OK_OUTPUT_SCHEMA,
    http: {
      method: 'DELETE',
      path: '/api/credentials/:id',
      pathParams: { id: 'id' },
      pathValidators: { id: 'id' },
      bodyMode: 'none',
    },
    cli: {
      command: ['credentials', 'delete'],
      positional: [{ field: 'id', required: true }],
    },
    // SECURITY: credentials.delete must NEVER be exposed as `core:credentials.delete`.
    action: false,
  },
] as const satisfies readonly CoreOperationSpec[]

export type ModelCoreOperation = (typeof MODEL_CORE_OPERATIONS)[number]
export type ModelCoreOperationKey = ModelCoreOperation['key']
export type ProviderCoreOperation = (typeof PROVIDER_CORE_OPERATIONS)[number]
export type ProviderCoreOperationKey = ProviderCoreOperation['key']
export type CredentialCoreOperation = (typeof CREDENTIAL_CORE_OPERATIONS)[number]
export type CredentialCoreOperationKey = CredentialCoreOperation['key']
