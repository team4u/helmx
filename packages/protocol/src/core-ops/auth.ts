/**
 * Declarative Core Operation specifications for the `auth` domain.
 *
 * SECURITY RED LINE: `auth.*` endpoints stay public pre-auth HTTP/CLI operations with `action: false`
 * so models and plugins can never initialize passwords or mint authentication tokens.
 */
import { REQUEST_SCHEMAS } from '../request-schemas.js'
import {
  CORE_EMPTY_INPUT_SCHEMA,
  CORE_OBJECT_OUTPUT_SCHEMA,
  cloneProtocolJsonSchema,
  type CoreOperationSpec,
} from './types.js'

export const AUTH_CORE_OPERATIONS = [
  {
    key: 'auth.status',
    domain: 'auth',
    id: 'status',
    description: 'View authentication status plus the local Hub lifecycle snapshot',
    inputSchema: CORE_EMPTY_INPUT_SCHEMA,
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/auth/status',
      bodyMode: 'none',
    },
    cli: {
      command: ['status'],
      description: 'View authentication status (GET /api/auth/status) plus the local Hub lifecycle snapshot',
    },
    action: false,
  },
  {
    key: 'auth.setup',
    domain: 'auth',
    id: 'setup',
    description: 'Initialize the admin password and log in (POST /api/auth/setup)',
    inputSchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.authPassword),
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/auth/setup',
      bodyMode: 'required',
    },
    cli: {
      command: ['setup'],
    },
    action: false,
  },
  {
    key: 'auth.login',
    domain: 'auth',
    id: 'login',
    description: 'Log in and save credentials (POST /api/auth/login)',
    inputSchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.authPassword),
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/auth/login',
      bodyMode: 'required',
    },
    cli: {
      command: ['login'],
    },
    action: false,
  },
] as const satisfies readonly CoreOperationSpec[]

export type AuthCoreOperation = (typeof AUTH_CORE_OPERATIONS)[number]
export type AuthCoreOperationKey = AuthCoreOperation['key']
