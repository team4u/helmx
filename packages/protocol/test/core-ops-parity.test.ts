import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ASK_CORE_OPERATIONS,
  AUTH_CORE_OPERATIONS,
  CONVERSATION_CORE_OPERATIONS,
  CORE_CLI_COMMAND_PATHS,
  CORE_OPERATIONS,
  CREDENTIAL_CORE_OPERATIONS,
  MODEL_CORE_OPERATIONS,
  NODE_CORE_OPERATIONS,
  OMNIBOX_CORE_OPERATIONS,
  PLUGIN_CORE_OPERATIONS,
  PROFILE_CORE_OPERATIONS,
  PROVIDER_CORE_OPERATIONS,
  SKILL_CORE_OPERATIONS,
  assertSchemaCompilable,
  type CoreOperationSpec,
} from '../src/index.js'

const EXPECTED_HOST_GOVERNANCE_SCOPE = { topLevelOnly: true, ownedBy: 'human' } as const
const EXPECTED_NO_CONVERSATION_SCOPE = { conversationIds: [] } as const

const VALID_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
  const props = schema['properties']
  return props !== null && typeof props === 'object' && !Array.isArray(props)
    ? (props as Record<string, unknown>)
    : {}
}

function queryParamFieldEntries(
  queryParams: CoreOperationSpec['http']['queryParams'],
): Array<readonly [queryKey: string, fieldName: string]> {
  if (!queryParams) return []
  if (Array.isArray(queryParams)) {
    return (queryParams as readonly string[]).map((name) => [name, name] as const)
  }
  return Object.entries(queryParams as Readonly<Record<string, string>>)
}

test('CORE_OPERATIONS aggregates all 7 core domains with unique keys, valid schemas/HTTP routes, and CLI path parity', { timeout: 60_000 }, () => {
  const expectedMerged: readonly CoreOperationSpec[] = [
    ...NODE_CORE_OPERATIONS,
    ...CONVERSATION_CORE_OPERATIONS,
    ...ASK_CORE_OPERATIONS,
    ...PROFILE_CORE_OPERATIONS,
    ...MODEL_CORE_OPERATIONS,
    ...PROVIDER_CORE_OPERATIONS,
    ...CREDENTIAL_CORE_OPERATIONS,
    ...AUTH_CORE_OPERATIONS,
    ...PLUGIN_CORE_OPERATIONS,
    ...SKILL_CORE_OPERATIONS,
    ...OMNIBOX_CORE_OPERATIONS,
  ]
  assert.deepEqual(CORE_OPERATIONS, expectedMerged)

  const expectedNamespaces = [
    'asks',
    'auth',
    'conversations',
    'credentials',
    'models',
    'nodes',
    'omnibox',
    'plugins',
    'profiles',
    'providers',
    'skills',
  ]
  const actualNamespaces = [...new Set(CORE_OPERATIONS.map((op) => op.domain))].sort()
  assert.deepEqual(actualNamespaces, expectedNamespaces)

  const seenKeys = new Set<string>()
  const seenHttpRoutes = new Set<string>()
  const cliPathSet = new Set<string>(CORE_CLI_COMMAND_PATHS)
  const opsByCliCommand = new Map<string, CoreOperationSpec[]>()

  for (const op of CORE_OPERATIONS as readonly CoreOperationSpec[]) {
    assert.equal(op.key, `${op.domain}.${op.id}`, `key must equal "<domain>.<id>" for ${op.key}`)
    assert.ok(!seenKeys.has(op.key), `duplicate operation key: ${op.key}`)
    seenKeys.add(op.key)

    assert.ok(typeof op.description === 'string' && op.description.trim().length > 0, `empty description on ${op.key}`)

    assert.ok(VALID_HTTP_METHODS.has(op.http.method), `invalid HTTP method on ${op.key}: ${op.http.method}`)
    assert.ok(op.http.path.startsWith('/api/'), `HTTP path must start with /api/ on ${op.key}: ${op.http.path}`)
    const httpRoute = `${op.http.method} ${op.http.path}`
    assert.ok(!seenHttpRoutes.has(httpRoute), `duplicate HTTP route ${httpRoute}`)
    seenHttpRoutes.add(httpRoute)

    if (op.http.bodyMode === 'none') {
      assert.equal(op.http.bodySchema, undefined, `${op.key} has bodyMode: 'none' and must not declare bodySchema`)
    }

    assertSchemaCompilable(op.inputSchema)
    assertSchemaCompilable(op.outputSchema)
    if (op.http.bodySchema !== undefined) {
      assertSchemaCompilable(op.http.bodySchema)
    }
    if (op.action !== false && op.action.inputSchema !== undefined) {
      assertSchemaCompilable(op.action.inputSchema)
    }

    const inputProps = schemaProperties(op.inputSchema)

    // Verify URL :param segments and pathValidators map cleanly onto inputSchema properties.
    const urlParams = new Set<string>()
    for (const match of op.http.path.matchAll(/:([A-Za-z0-9_]+)/g)) {
      const paramName = match[1]!
      urlParams.add(paramName)
      const fieldName = op.http.pathParams?.[paramName] ?? paramName
      assert.ok(
        Object.hasOwn(inputProps, fieldName),
        `${op.key}: path param :${paramName} -> "${fieldName}" missing in inputSchema.properties`,
      )
    }
    if (op.http.pathParams) {
      for (const paramName of Object.keys(op.http.pathParams)) {
        assert.ok(urlParams.has(paramName), `${op.key}: pathParams.${paramName} not present in ${op.http.path}`)
      }
    }
    if (op.http.pathValidators) {
      for (const paramName of Object.keys(op.http.pathValidators)) {
        assert.ok(urlParams.has(paramName), `${op.key}: pathValidators.${paramName} not present in ${op.http.path}`)
      }
    }

    for (const [, fieldName] of queryParamFieldEntries(op.http.queryParams)) {
      assert.ok(
        Object.hasOwn(inputProps, fieldName),
        `${op.key}: query field "${fieldName}" missing in inputSchema.properties`,
      )
    }

    assert.ok(op.cli.command.length > 0, `${op.key}: cli.command must not be empty`)
    const cmdPath = op.cli.command.join(' ')
    assert.ok(
      cliPathSet.has(cmdPath),
      `${op.key}: CLI command "${cmdPath}" missing in CORE_CLI_COMMAND_PATHS`,
    )
    if (op.cli.positional) {
      for (const pos of op.cli.positional) {
        assert.ok(
          Object.hasOwn(inputProps, pos.field),
          `${op.key}: cli.positional field "${pos.field}" missing in inputSchema.properties`,
        )
      }
    }
    if (op.cli.flagAliases) {
      for (const propName of Object.keys(op.cli.flagAliases)) {
        assert.ok(
          Object.hasOwn(inputProps, propName),
          `${op.key}: cli.flagAliases key "${propName}" missing in inputSchema.properties`,
        )
      }
    }

    const group = opsByCliCommand.get(cmdPath) ?? []
    group.push(op)
    opsByCliCommand.set(cmdPath, group)
  }

  // Verify sharedCommand invariants: colliding cli.command entries must opt into sharedCommand: true
  // and stay compatible across domain, positional definitions, and flag aliases.
  for (const [cmdPath, group] of opsByCliCommand) {
    if (group.length > 1) {
      const domains = new Set(group.map((op) => op.domain))
      assert.equal(domains.size, 1, `shared CLI command "${cmdPath}" spans incompatible domains: ${[...domains].join(', ')}`)

      const fieldToFlag = new Map<string, string>()
      const flagToField = new Map<string, string>()
      let referencePositional: readonly unknown[] | undefined

      for (const op of group) {
        assert.equal(
          op.cli.sharedCommand,
          true,
          `CLI command collision on "${cmdPath}": ${op.key} must declare sharedCommand: true`,
        )
        if (op.cli.positional !== undefined) {
          if (referencePositional === undefined) {
            referencePositional = op.cli.positional
          } else {
            assert.deepEqual(
              op.cli.positional,
              referencePositional,
              `shared CLI command "${cmdPath}" has divergent positional definitions on ${op.key}`,
            )
          }
        }
        if (op.cli.flagAliases) {
          for (const [field, flag] of Object.entries(op.cli.flagAliases)) {
            const existingFlag = fieldToFlag.get(field)
            assert.ok(
              existingFlag === undefined || existingFlag === flag,
              `shared CLI command "${cmdPath}" maps field "${field}" to conflicting flags: ${existingFlag} vs ${flag}`,
            )
            fieldToFlag.set(field, flag)

            const existingField = flagToField.get(flag)
            assert.ok(
              existingField === undefined || existingField === field,
              `shared CLI command "${cmdPath}" maps flag "--${flag}" to conflicting fields: ${existingField} vs ${field}`,
            )
            flagToField.set(flag, field)
          }
        }
      }
    }
  }
})

test('CORE_OPERATIONS enforces exact action exclusion and governance scope security invariants across all domains', { timeout: 60_000 }, () => {
  const expectedNonActionKeys = new Set([
    'nodes.issue',
    'conversations.bulk_delete',
    'conversations.artifacts_list',
    'providers.list',
    'providers.set',
    'credentials.list',
    'credentials.set',
    'credentials.delete',
    'auth.status',
    'auth.setup',
    'auth.login',
    'plugins.install',
    'plugins.update',
    'plugins.remove',
    'omnibox.search',
  ])

  const actualNonActionKeys = new Set<string>()
  const byKey = new Map<string, CoreOperationSpec>()

  for (const op of CORE_OPERATIONS as readonly CoreOperationSpec[]) {
    byKey.set(op.key, op)
    if (op.action === false) {
      actualNonActionKeys.add(op.key)
    } else {
      assert.equal(
        op.action.exposeToPrompt,
        false,
        `core:* action ${op.key} must keep exposeToPrompt: false`,
      )
    }
  }

  for (const key of expectedNonActionKeys) {
    const op = byKey.get(key)
    assert.ok(op !== undefined, `missing expected security/non-action operation ${key}`)
    assert.equal(op.action, false, `SECURITY RED LINE: ${key} must keep action: false`)
  }
  assert.deepEqual(
    [...actualNonActionKeys].sort(),
    [...expectedNonActionKeys].sort(),
    'non-action operation set must stay explicitly accounted for',
  )

  // Verify models.default_get matches core:models action contract (`idempotent: true`, shared CLI command)
  const modelsDefaultGet = byKey.get('models.default_get')
  assert.ok(modelsDefaultGet && modelsDefaultGet.action !== false)
  assert.equal(modelsDefaultGet.action.idempotent, true)

  // Verify host governance & no-conversation scope guards on sensitive core:* actions
  for (const key of [
    'nodes.remove',
    'nodes.upgrade',
    'nodes.forward_stop',
    'asks.cancel',
    'plugins.config_set',
    'plugins.enable',
    'plugins.disable',
    'plugins.reload',
    'plugins.rescan',
  ]) {
    const op = byKey.get(key)
    assert.ok(op && op.action !== false, `missing actionable governance operation ${key}`)
    assert.deepEqual(op.action.scope, EXPECTED_HOST_GOVERNANCE_SCOPE, `${key} must enforce host governance scope`)
  }

  for (const key of ['asks.answer', 'skills.list', 'skills.read']) {
    const op = byKey.get(key)
    assert.ok(op && op.action !== false, `missing actionable non-conversation operation ${key}`)
    assert.deepEqual(op.action.scope, EXPECTED_NO_CONVERSATION_SCOPE, `${key} must enforce no-conversation scope`)
  }
})
