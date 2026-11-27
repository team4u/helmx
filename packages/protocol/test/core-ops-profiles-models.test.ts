import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUTH_CORE_OPERATIONS,
  CORE_CLI_COMMAND_PATHS,
  CORE_OPERATIONS,
  CREDENTIAL_CORE_OPERATIONS,
  MODEL_CORE_OPERATIONS,
  PROFILE_CORE_OPERATIONS,
  PROVIDER_CORE_OPERATIONS,
  assertSchemaCompilable,
  type CoreOperationSpec,
} from '../src/index.js'

function assertOperationsValid(ops: readonly CoreOperationSpec[], label: string): void {
  const seenKeys = new Set<string>()
  const seenHttpRoutes = new Set<string>()
  const cliPathSet = new Set<string>(CORE_CLI_COMMAND_PATHS)

  for (const op of ops) {
    assert.ok(!seenKeys.has(op.key), `${label}: duplicate key ${op.key}`)
    seenKeys.add(op.key)

    const route = `${op.http.method} ${op.http.path}`
    assert.ok(!seenHttpRoutes.has(route), `${label}: duplicate HTTP route ${route}`)
    seenHttpRoutes.add(route)

    assertSchemaCompilable(op.inputSchema)
    assertSchemaCompilable(op.outputSchema)
    if (op.http.bodySchema !== undefined) {
      assertSchemaCompilable(op.http.bodySchema)
    }
    if (op.action !== false && op.action.inputSchema !== undefined) {
      assertSchemaCompilable(op.action.inputSchema)
    }
    assert.ok(
      cliPathSet.has(op.cli.command.join(' ')),
      `${label}: CLI command missing in CORE_CLI_COMMAND_PATHS: ${op.cli.command.join(' ')}`,
    )
  }
}

test('core-ops/profiles: declarative PROFILE_CORE_OPERATIONS stay valid with 405 policy and PUT/action update split', { timeout: 60_000 }, () => {
  assert.equal(PROFILE_CORE_OPERATIONS.length, 5)
  assertOperationsValid(PROFILE_CORE_OPERATIONS, 'profiles')

  for (const op of PROFILE_CORE_OPERATIONS) {
    assert.equal(op.domain, 'profiles')
    assert.equal(op.http.methodNotAllowed, true, `${op.key} must enforce 405 method_not_allowed`)
    assert.notEqual(op.action, false)
  }

  const update: CoreOperationSpec | undefined = PROFILE_CORE_OPERATIONS.find((op) => op.key === 'profiles.update')
  assert.ok(update)
  assert.equal(update.http.method, 'PUT')
  assert.equal(update.http.pathParams?.id, 'profileId')
  assert.ok(update.http.bodySchema !== undefined, 'profiles.update should validate unmerged HTTP body with optional id')
  assert.ok(update.action !== false && update.action.inputSchema !== undefined)
  assert.deepEqual(update.action.inputSchema.required, ['id'])
})

test('core-ops/models-providers-credentials-auth: security red lines keep credentials/providers/auth at action:false', { timeout: 60_000 }, () => {
  assert.equal(MODEL_CORE_OPERATIONS.length, 6)
  assert.equal(PROVIDER_CORE_OPERATIONS.length, 2)
  assert.equal(CREDENTIAL_CORE_OPERATIONS.length, 3)
  assert.equal(AUTH_CORE_OPERATIONS.length, 3)

  assertOperationsValid(MODEL_CORE_OPERATIONS, 'models')
  assertOperationsValid(PROVIDER_CORE_OPERATIONS, 'providers')
  assertOperationsValid(CREDENTIAL_CORE_OPERATIONS, 'credentials')
  assertOperationsValid(AUTH_CORE_OPERATIONS, 'auth')

  for (const op of [...PROVIDER_CORE_OPERATIONS, ...CREDENTIAL_CORE_OPERATIONS, ...AUTH_CORE_OPERATIONS]) {
    assert.equal(op.action, false, `SECURITY RED LINE: ${op.key} must set action: false`)
  }
  for (const op of PROVIDER_CORE_OPERATIONS) {
    assert.equal(op.http.methodNotAllowed, true, `${op.key} must enforce 405 method_not_allowed`)
  }

  const defaultGet: CoreOperationSpec | undefined = MODEL_CORE_OPERATIONS.find((op) => op.key === 'models.default_get')
  assert.ok(defaultGet)
  assert.ok(defaultGet.action !== false)
  assert.equal(defaultGet.action.idempotent, true)
  assert.equal(defaultGet.cli.sharedCommand, true)
  assert.deepEqual(defaultGet.cli.command, ['models', 'default'])

  assertOperationsValid(CORE_OPERATIONS, 'CORE_OPERATIONS')
})
