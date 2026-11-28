/**
 * Declarative Core Operation specifications for the `omnibox` domain.
 * Drives HTTP (`GET /api/omnibox/search`) and static `helmx omnibox search` CLI command.
 */
import { REQUEST_SCHEMAS } from '../request-schemas.js'
import {
  CORE_OBJECT_OUTPUT_SCHEMA,
  cloneProtocolJsonSchema,
  type CoreOperationSpec,
} from './types.js'

export const OMNIBOX_CORE_OPERATIONS = [
  {
    key: 'omnibox.search',
    domain: 'omnibox',
    id: 'search',
    description:
      'Unified Omnibox async search combining conversation full-text hits and active helmx.search plugin providers',
    inputSchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.omniboxSearchQuery),
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/omnibox/search',
      queryParams: ['q', 'limit', 'locale', 'conversationId'],
      bodyMode: 'none',
      methodNotAllowed: true,
    },
    cli: {
      command: ['omnibox', 'search'],
      positional: [{ field: 'q', required: true, label: 'query' }],
      flagAliases: { conversationId: 'conversation' },
    },
    action: false,
  },
] as const satisfies readonly CoreOperationSpec[]

export type OmniboxCoreOperation = (typeof OMNIBOX_CORE_OPERATIONS)[number]
export type OmniboxCoreOperationKey = OmniboxCoreOperation['key']
