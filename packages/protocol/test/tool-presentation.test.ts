import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ARTIFACT_READ_META_SCHEMA,
  ARTIFACT_REGISTER_META_SCHEMA,
  BASH_TOOL_META_SCHEMA,
  EDIT_TOOL_RESULT_SCHEMA,
  HelmxError,
  KERNEL_TOOL_NAMES,
  KERNEL_TOOL_PRESENTATION_META_SCHEMAS,
  READ_TOOL_META_SCHEMA,
  TOOL_DIFF_MAX_ROWS,
  TOOL_DIFF_MAX_ROW_CHARS,
  TOOL_PRESENTATION_META_MAX_BYTES,
  TOOL_PRESENTATION_META_MAX_DEPTH,
  TOOL_PRESENTATION_META_MAX_NODES,
  WRITE_TOOL_META_SCHEMA,
  assertBoundedPresentationMeta,
  assertSchemaCompilable,
  validateEditToolResult,
  validateOrThrow,
  type EditToolResult,
  type KernelToolName,
} from '../src/index.js'

function result(): EditToolResult {
  return {
    path: '/workspace/example.ts',
    nodeId: 'remote-a',
    replaced: true,
    diff: {
      rows: [
        { kind: 'context', oldLine: 7, newLine: 7, text: 'function run() {' },
        { kind: 'remove', oldLine: 8, text: '  return 1' },
        { kind: 'add', newLine: 8, text: '  return 2' },
      ],
      addedLines: 1,
      removedLines: 1,
      firstChangedLine: 8,
      truncated: false,
    },
  }
}

function validate(value: unknown): void {
  validateOrThrow(EDIT_TOOL_RESULT_SCHEMA, value, 'invalid edit diff result')
  assert.equal(validateEditToolResult(value).ok, true)
}

test('edit presentation contract accepts real line numbers, truncated diffs and no-op results', { timeout: 60_000 }, () => {
  validate(result())
  const truncated = result()
  truncated.diff.rows = []
  truncated.diff.truncated = true
  validate(truncated)
  const unchanged = result()
  unchanged.diff.rows = []
  unchanged.diff.addedLines = 0
  unchanged.diff.removedLines = 0
  validate(unchanged)
})

test('edit presentation boundary rejects missing fields, wrong row shapes and unrepresentable line numbers', { timeout: 60_000 }, () => {
  const invalid: unknown[] = [
    { path: '/workspace/example.ts', nodeId: 'local', replaced: true },
    { ...result(), replaced: false },
    { ...result(), nodeId: '' },
    ...[
      { kind: 'context', oldLine: 1, text: 'missing newLine' },
      { kind: 'remove', oldLine: 1, newLine: 1, text: 'unexpected newLine' },
      { kind: 'add', newLine: 0, text: 'zero line' },
      { kind: 'add', newLine: 1.5, text: 'fractional line' },
      { kind: 'add', newLine: Number.MAX_SAFE_INTEGER + 1, text: 'unsafe line' },
      { kind: 'unknown', oldLine: 1, text: 'unknown row' },
    ].map((row) => ({ ...result(), diff: { ...result().diff, rows: [row] } })),
    { ...result(), diff: { ...result().diff, addedLines: -1 } },
  ]
  for (const value of invalid) {
    assert.throws(() => validateOrThrow(EDIT_TOOL_RESULT_SCHEMA, value, 'invalid edit diff result'), /invalid edit diff result/)
    assert.equal(validateEditToolResult(value).ok, false)
  }
})

test('edit presentation boundary rejects excess rows and over-long row text', { timeout: 60_000 }, () => {
  const row = { kind: 'add', newLine: 1, text: 'line' }
  const tooManyRows = { ...result(), diff: { ...result().diff, rows: Array.from({ length: TOOL_DIFF_MAX_ROWS + 1 }, () => row) } }
  const tooLongRow = { ...result(), diff: { ...result().diff, rows: [{ ...row, text: 'x'.repeat(TOOL_DIFF_MAX_ROW_CHARS + 1) }] } }
  for (const bad of [tooManyRows, tooLongRow]) {
    assert.throws(
      () => validateOrThrow(EDIT_TOOL_RESULT_SCHEMA, bad, 'invalid edit diff result'),
      /invalid edit diff result/,
    )
    assert.equal(validateEditToolResult(bad).ok, false)
  }
})

test('schema validator rejects $async and malformed JSON Schema declarations with invalid_plugin_schema', { timeout: 60_000 }, () => {
  assertSchemaCompilable(EDIT_TOOL_RESULT_SCHEMA)
  const badSchemas: unknown[] = [
    null,
    'not-an-object',
    [],
    { type: 'object', $async: true },
    { type: 'object', properties: { nested: { type: 'string', $async: true } } },
    { type: 'not-a-type' },
    { type: ['string', 'quux'] },
    { type: 'string', pattern: '[unclosed' },
    { type: 'object', required: 'not-an-array' },
    { type: 'array', minItems: -1 },
  ]
  for (const bad of badSchemas) {
    assert.throws(
      () => assertSchemaCompilable(bad as never),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_plugin_schema' && err.status === 500,
    )
    assert.throws(
      () => validateOrThrow(bad as never, {}, 'bad schema'),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_plugin_schema' && err.status === 500,
    )
  }
})

test('assertBoundedPresentationMeta: enforces 64 KiB UTF-8 byte cap, depth 12, and 2000 nodes without truncation', { timeout: 60_000 }, () => {
  assert.equal(TOOL_PRESENTATION_META_MAX_BYTES, 65_536)
  assert.equal(TOOL_PRESENTATION_META_MAX_DEPTH, 12)
  assert.equal(TOOL_PRESENTATION_META_MAX_NODES, 2_000)

  // Exact 64 KiB ASCII payload passes (`{"s":""}` is 8 bytes + 65528 = 65536).
  const exactAscii = { s: 'a'.repeat(TOOL_PRESENTATION_META_MAX_BYTES - 8) }
  assert.equal(Buffer.byteLength(JSON.stringify(exactAscii), 'utf8'), TOOL_PRESENTATION_META_MAX_BYTES)
  assert.deepEqual(assertBoundedPresentationMeta(exactAscii), exactAscii)

  // 64 KiB + 1 byte fails explicitly (never silently truncates).
  assert.throws(
    () => assertBoundedPresentationMeta({ s: 'a'.repeat(TOOL_PRESENTATION_META_MAX_BYTES - 7) }, { label: 'tool demo' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.status === 500 && err.message.includes('max byte size'),
  )

  // Multibyte CJK: UTF-8 byte length (3 bytes/char) exceeds 64 KiB even though JS string length is ~21.8k.
  const cjkOver = { s: '中'.repeat(21_843) }
  assert.ok(cjkOver.s.length < TOOL_PRESENTATION_META_MAX_BYTES)
  assert.throws(
    () => assertBoundedPresentationMeta(cjkOver),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('max byte size'),
  )
  const cjkFit = { s: '中'.repeat(21_842) }
  assert.deepEqual(assertBoundedPresentationMeta(cjkFit), cjkFit)

  // Nesting depth: root object = depth 1; depth 12 container with primitive leaf passes, depth 13 rejects.
  const makeNested = (depth: number, leaf: unknown): Record<string, unknown> => {
    let cur: unknown = leaf
    for (let i = 0; i < depth - 1; i += 1) cur = { next: cur }
    return cur as Record<string, unknown>
  }
  assert.deepEqual(assertBoundedPresentationMeta(makeNested(TOOL_PRESENTATION_META_MAX_DEPTH, { leaf: 'ok' })), makeNested(TOOL_PRESENTATION_META_MAX_DEPTH, { leaf: 'ok' }))
  assert.throws(
    () => assertBoundedPresentationMeta(makeNested(TOOL_PRESENTATION_META_MAX_DEPTH + 1, { leaf: 'too deep' })),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('max nesting depth'),
  )
  // Depth 13 array container also rejected.
  assert.throws(
    () => assertBoundedPresentationMeta(makeNested(TOOL_PRESENTATION_META_MAX_DEPTH + 1, [1])),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('max nesting depth'),
  )

  // Node cap: root (1) + array (1) + 1998 leaves = 2000 passes; 1999 leaves = 2001 rejects.
  const exactNodes = { items: Array.from({ length: TOOL_PRESENTATION_META_MAX_NODES - 2 }, (_, i) => i) }
  assert.equal((assertBoundedPresentationMeta(exactNodes)['items'] as number[]).length, TOOL_PRESENTATION_META_MAX_NODES - 2)
  assert.throws(
    () => assertBoundedPresentationMeta({ items: Array.from({ length: TOOL_PRESENTATION_META_MAX_NODES - 1 }, (_, i) => i) }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('max node count'),
  )

  // Shared non-circular DAG reference is allowed and cloned independently.
  const shared = { tag: 'x' }
  const dag = assertBoundedPresentationMeta({ a: shared, b: shared })
  assert.deepEqual(dag, { a: { tag: 'x' }, b: { tag: 'x' } })
  assert.notEqual(dag['a'], shared)
  assert.notEqual(dag['a'], dag['b'])

  // Null-prototype plain object is accepted and normalized to a plain object clone.
  const nullProto = Object.create(null) as Record<string, unknown>
  nullProto['ok'] = true
  assert.deepEqual(assertBoundedPresentationMeta(nullProto), { ok: true })
})

test('assertBoundedPresentationMeta: rejects non-plain objects, prototype keys, cycles, non-finite/undefined/sparse values, and supports redact + schema', { timeout: 60_000 }, () => {
  class Box {
    value = 1
  }
  const nonPlainTop: unknown[] = [null, undefined, 'str', 123, true, [1, 2], new Date(), new Map(), new Set(), new Box(), () => {}]
  for (const bad of nonPlainTop) {
    assert.throws(
      () => assertBoundedPresentationMeta(bad),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.status === 500,
    )
  }

  // Prototype keys at root, nested, null-prototype, and non-enumerable own property.
  const nonEnumProto: Record<string, unknown> = {}
  Object.defineProperty(nonEnumProto, '__proto__', { value: { polluted: true }, enumerable: false })
  const nullProtoWithKey = Object.create(null) as Record<string, unknown>
  nullProtoWithKey['__proto__'] = 1
  const protoCases: unknown[] = [
    JSON.parse('{"__proto__":{"polluted":true}}'),
    JSON.parse('{"nested":{"__proto__":1}}'),
    { constructor: { bad: true } },
    { nested: { prototype: {} } },
    nonEnumProto,
    nullProtoWithKey,
  ]
  for (const bad of protoCases) {
    assert.throws(
      () => assertBoundedPresentationMeta(bad),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('prototype key'),
    )
  }

  // Circular references (self, mutual, array cycle).
  const selfCycle: Record<string, unknown> = {}
  selfCycle['self'] = selfCycle
  const a: Record<string, unknown> = {}
  const b: Record<string, unknown> = { a }
  a['b'] = b
  const cyclicArr: unknown[] = []
  cyclicArr.push(cyclicArr)
  for (const cyclic of [selfCycle, a, { arr: cyclicArr }]) {
    assert.throws(
      () => assertBoundedPresentationMeta(cyclic),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('circular reference'),
    )
  }

  // Non-finite numbers, undefined, sparse array, non-plain nested objects, function/symbol/bigint.
  const sparse = [1, , 3]
  const invalidValues: unknown[] = [
    { n: Number.NaN },
    { n: Number.POSITIVE_INFINITY },
    { n: Number.NEGATIVE_INFINITY },
    { undef: undefined },
    { list: [undefined] },
    { list: sparse },
    { d: new Date() },
    { m: new Map() },
    { box: new Box() },
    { fn: () => {} },
    { sym: Symbol('s') },
    { big: 1n },
  ]
  for (const bad of invalidValues) {
    assert.throws(
      () => assertBoundedPresentationMeta(bad),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.status === 500,
    )
  }

  // Redaction + schema validation + redacted key collision + post-redaction prototype key & byte growth.
  const redact = (t: string) => t.replaceAll('SECRET', '[REDACTED]')
  const schema = {
    type: 'object',
    properties: { badge: { type: 'string' }, count: { type: 'integer' } },
    required: ['badge', 'count'],
    additionalProperties: false,
  }
  assert.deepEqual(
    assertBoundedPresentationMeta({ badge: 'tok=SECRET', count: 2 }, { redact, schema }),
    { badge: 'tok=[REDACTED]', count: 2 },
  )
  assert.throws(
    () => assertBoundedPresentationMeta({ badge: 'ok', count: 'bad' }, { redact, schema }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('presentationMetaSchema'),
  )
  assert.throws(
    () => assertBoundedPresentationMeta({ badge: 'ok', count: 1 }, { schema: { type: 'object', $async: true } }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_plugin_schema' && err.status === 500,
  )
  assert.throws(
    () => assertBoundedPresentationMeta({ SECRET_1: 'a', SECRET_2: 'b' }, { redact: (t) => t.replace(/SECRET_\d/, 'DUP') }),
    (err: unknown) => err instanceof HelmxError && err.code === 'redacted_key_conflict' && err.status === 500,
  )
  assert.throws(
    () => assertBoundedPresentationMeta({ safeKey: 'a' }, { redact: (t) => (t === 'safeKey' ? '__proto__' : t) }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('prototype key'),
  )
  assert.throws(
    () => assertBoundedPresentationMeta({ s: 'X' }, { maxBytes: 12, redact: (t) => t.replaceAll('X', 'EXPANDED_VALUE') }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('max byte size'),
  )
})

test('assertBoundedPresentationMeta: inspects Reflect.ownKeys and rejects symbol keys, non-enumerable properties, and array extra fields without silent dropping', { timeout: 60_000 }, () => {
  const redact = (t: string) => t.replaceAll('SECRET', '[REDACTED]')

  // 1. Symbol own keys on objects (enumerable, non-enumerable, well-known, nested, null-prototype).
  const enumSym: Record<PropertyKey, unknown> = { ok: true, [Symbol('tag')]: 'v' }
  const nonEnumSym: Record<PropertyKey, unknown> = { ok: true }
  Object.defineProperty(nonEnumSym, Symbol('hidden'), { value: 'v', enumerable: false })
  const wellKnownSym: Record<PropertyKey, unknown> = { ok: true, [Symbol.toStringTag]: 'Custom' }
  const nullProtoSym = Object.create(null) as Record<PropertyKey, unknown>
  nullProtoSym['ok'] = true
  nullProtoSym[Symbol('nullProto')] = 1
  const nestedSym = { nested: { [Symbol('deep')]: 'x' } }

  for (const bad of [enumSym, nonEnumSym, wellKnownSym, nullProtoSym, nestedSym]) {
    assert.throws(
      () => assertBoundedPresentationMeta(bad),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.status === 500 && err.message.includes('symbol key'),
    )
  }

  // Secret inside Symbol description is redacted in diagnostic message.
  assert.throws(
    () => assertBoundedPresentationMeta({ [Symbol('SECRET_TAG')]: 1 }, { redact }),
    (err: unknown) =>
      err instanceof HelmxError &&
      err.code === 'invalid_tool_result' &&
      !err.message.includes('SECRET') &&
      err.message.includes('[REDACTED]'),
  )

  // 2. Non-enumerable own string keys on objects (root, nested, null-prototype, toJSON, non-enumerable getter not invoked).
  const nonEnumRoot: Record<string, unknown> = { ok: true }
  Object.defineProperty(nonEnumRoot, 'hidden', { value: 'SECRET', enumerable: false })

  const nonEnumNestedInner: Record<string, unknown> = { a: 1 }
  Object.defineProperty(nonEnumNestedInner, 'hidden', { value: 2, enumerable: false })

  const nonEnumNullProto = Object.create(null) as Record<string, unknown>
  nonEnumNullProto['ok'] = true
  Object.defineProperty(nonEnumNullProto, 'hidden', { value: 3, enumerable: false })

  const nonEnumToJson: Record<string, unknown> = { ok: true }
  Object.defineProperty(nonEnumToJson, 'toJSON', { value: () => ({ forged: true }), enumerable: false })

  let hiddenGetterCalled = false
  const nonEnumGetter: Record<string, unknown> = { ok: true }
  Object.defineProperty(nonEnumGetter, 'lazy', {
    get() {
      hiddenGetterCalled = true
      return 'should-not-run'
    },
    enumerable: false,
  })

  for (const bad of [nonEnumRoot, { inner: nonEnumNestedInner }, nonEnumNullProto, nonEnumToJson, nonEnumGetter]) {
    assert.throws(
      () => assertBoundedPresentationMeta(bad),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.status === 500 && err.message.includes('non-enumerable'),
    )
  }
  assert.equal(hiddenGetterCalled, false, 'non-enumerable getter must be rejected without invocation')

  // Secret inside non-enumerable key name is redacted in diagnostic message and details.
  const secretNonEnumKey: Record<string, unknown> = { ok: true }
  Object.defineProperty(secretNonEnumKey, 'SECRET_FIELD', { value: 'SECRET_VALUE', enumerable: false })
  assert.throws(
    () => assertBoundedPresentationMeta(secretNonEnumKey, { redact }),
    (err: unknown) =>
      err instanceof HelmxError &&
      err.code === 'invalid_tool_result' &&
      !err.message.includes('SECRET') &&
      !JSON.stringify(err.details ?? {}).includes('SECRET'),
  )

  // 3. Accessors (enumerable getters and write-only setters on objects and arrays) must be rejected WITHOUT invocation.
  let enumGetterCalled = false
  const enumGetterRoot: Record<string, unknown> = { ok: true }
  Object.defineProperty(enumGetterRoot, 'badge', {
    get() {
      enumGetterCalled = true
      return 'forged'
    },
    enumerable: true,
  })
  const enumGetterNestedInner: Record<string, unknown> = { ok: true }
  Object.defineProperty(enumGetterNestedInner, 'badge', {
    get() {
      enumGetterCalled = true
      return 'forged'
    },
    enumerable: true,
  })
  const enumGetterNullProto = Object.create(null) as Record<string, unknown>
  enumGetterNullProto['ok'] = true
  Object.defineProperty(enumGetterNullProto, 'badge', {
    get() {
      enumGetterCalled = true
      return 'forged'
    },
    enumerable: true,
  })
  const writeOnlySetter: Record<string, unknown> = { ok: true }
  Object.defineProperty(writeOnlySetter, 'dropMe', { set() {}, enumerable: true })

  for (const bad of [enumGetterRoot, { inner: enumGetterNestedInner }, enumGetterNullProto, writeOnlySetter]) {
    assert.throws(
      () => assertBoundedPresentationMeta(bad),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.status === 500 && err.message.includes('accessor'),
    )
  }
  assert.equal(enumGetterCalled, false, 'enumerable getter on details/presentationMeta must be rejected without invocation')

  // Secret inside enumerable accessor key name is redacted in diagnostic message and details.
  const secretAccessorKey: Record<string, unknown> = { ok: true }
  Object.defineProperty(secretAccessorKey, 'SECRET_GETTER', {
    get() {
      enumGetterCalled = true
      return 'SECRET_VAL'
    },
    enumerable: true,
  })
  assert.throws(
    () => assertBoundedPresentationMeta(secretAccessorKey, { redact }),
    (err: unknown) =>
      err instanceof HelmxError &&
      err.code === 'invalid_tool_result' &&
      err.message.includes('accessor') &&
      !err.message.includes('SECRET') &&
      !JSON.stringify(err.details ?? {}).includes('SECRET'),
  )
  assert.equal(enumGetterCalled, false, 'secret-named enumerable getter must not be invoked')

  const arrEnumGetter = [1, 2]
  Object.defineProperty(arrEnumGetter, '0', {
    get() {
      enumGetterCalled = true
      return 1
    },
    enumerable: true,
  })
  assert.throws(
    () => assertBoundedPresentationMeta({ list: arrEnumGetter }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('accessor'),
  )
  assert.equal(enumGetterCalled, false, 'enumerable array element getter must be rejected without invocation')

  // 4. Arrays: extra string/symbol/non-enumerable properties, prototype keys, non-enumerable elements, and Array subclasses.
  const arrExtra = [1, 2] as unknown[] & { extra?: string }
  arrExtra.extra = 'SECRET'
  const arrNonEnumExtra = [1, 2]
  Object.defineProperty(arrNonEnumExtra, 'hidden', { value: 'SECRET', enumerable: false })
  const arrLeadingZero = [1, 2]
  Object.defineProperty(arrLeadingZero, '01', { value: 9, enumerable: true })
  const arrEmptyExtra = [] as unknown[] & { tag?: string }
  arrEmptyExtra.tag = 'x'
  for (const badArr of [arrExtra, arrNonEnumExtra, arrLeadingZero, arrEmptyExtra]) {
    assert.throws(
      () => assertBoundedPresentationMeta({ list: badArr }, { redact }),
      (err: unknown) =>
        err instanceof HelmxError &&
        err.code === 'invalid_tool_result' &&
        err.status === 500 &&
        err.message.includes('extra own property') &&
        !err.message.includes('SECRET'),
    )
  }

  const arrEnumSym = [1] as unknown[] & Record<symbol, unknown>
  arrEnumSym[Symbol('arrTag')] = 'x'
  const arrNonEnumSym = [1]
  Object.defineProperty(arrNonEnumSym, Symbol('arrHidden'), { value: 'x', enumerable: false })
  for (const badArr of [arrEnumSym, arrNonEnumSym]) {
    assert.throws(
      () => assertBoundedPresentationMeta({ list: badArr }),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('symbol key'),
    )
  }

  const arrProto = [1]
  Object.defineProperty(arrProto, '__proto__', { value: { polluted: true }, enumerable: false })
  const arrCtor = [1] as unknown[] & { constructor?: unknown }
  arrCtor.constructor = { bad: true }
  for (const badArr of [arrProto, arrCtor]) {
    assert.throws(
      () => assertBoundedPresentationMeta({ list: badArr }),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('prototype key'),
    )
  }

  let hiddenElemGetterCalled = false
  const arrNonEnumElem = [1, 2]
  Object.defineProperty(arrNonEnumElem, '0', {
    get() {
      hiddenElemGetterCalled = true
      return 1
    },
    enumerable: false,
  })
  assert.throws(
    () => assertBoundedPresentationMeta({ list: arrNonEnumElem }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('non-enumerable'),
  )
  assert.equal(hiddenElemGetterCalled, false, 'non-enumerable array element getter must be rejected without invocation')

  class CustomArray extends Array {}
  const subArr = new CustomArray()
  subArr.push(1, 2)
  assert.throws(
    () => assertBoundedPresentationMeta({ list: subArr }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('non-plain array'),
  )

  // Valid dense arrays & plain objects with normal string/numeric keys continue to pass cleanly.
  assert.deepEqual(
    assertBoundedPresentationMeta({ ok: true, '0': 'zero', list: [1, { nested: 'SECRET' }] }, { redact }),
    { ok: true, '0': 'zero', list: [1, { nested: '[REDACTED]' }] },
  )
})

test('kernel builtin tool presentationMeta schemas compile and enforce strict shapes', { timeout: 60_000 }, () => {
  for (const schema of Object.values(KERNEL_TOOL_PRESENTATION_META_SCHEMAS)) {
    assertSchemaCompilable(schema)
  }
  assert.equal(KERNEL_TOOL_PRESENTATION_META_SCHEMAS['read'], READ_TOOL_META_SCHEMA)
  assert.equal(KERNEL_TOOL_PRESENTATION_META_SCHEMAS['write'], WRITE_TOOL_META_SCHEMA)
  assert.equal(KERNEL_TOOL_PRESENTATION_META_SCHEMAS['edit'], EDIT_TOOL_RESULT_SCHEMA)
  assert.equal(KERNEL_TOOL_PRESENTATION_META_SCHEMAS['bash'], BASH_TOOL_META_SCHEMA)
  assert.equal(KERNEL_TOOL_PRESENTATION_META_SCHEMAS['register_artifact'], ARTIFACT_REGISTER_META_SCHEMA)
  assert.equal(KERNEL_TOOL_PRESENTATION_META_SCHEMAS['read_artifact'], ARTIFACT_READ_META_SCHEMA)

  assertBoundedPresentationMeta({ path: '/a.ts', nodeId: 'local' }, { schema: READ_TOOL_META_SCHEMA })
  assert.throws(() => assertBoundedPresentationMeta({ path: '/a.ts', nodeId: 'local', content: 'leak' }, { schema: READ_TOOL_META_SCHEMA }))

  assertBoundedPresentationMeta({ path: '/a.ts', nodeId: 'local', bytesWritten: 42 }, { schema: WRITE_TOOL_META_SCHEMA })
  assertBoundedPresentationMeta({ path: '/a.ts', nodeId: 'local', bytesWritten: 42, artifactId: 'art-1' }, { schema: WRITE_TOOL_META_SCHEMA })

  assertBoundedPresentationMeta({ ok: true, exitCode: 0, timedOut: false, nodeId: 'local', cwd: '/work' }, { schema: BASH_TOOL_META_SCHEMA })
  assertBoundedPresentationMeta({ ok: false, exitCode: null, timedOut: true }, { schema: BASH_TOOL_META_SCHEMA })
  assert.throws(() => assertBoundedPresentationMeta({ ok: true, exitCode: 0, timedOut: false, output: 'stdout' }, { schema: BASH_TOOL_META_SCHEMA }))

  assertBoundedPresentationMeta(
    { artifactId: 'a1', path: '/f.txt', nodeId: 'local', name: 'f.txt', size: 10, mimeType: 'text/plain' },
    { schema: ARTIFACT_REGISTER_META_SCHEMA },
  )
  assert.throws(() =>
    assertBoundedPresentationMeta(
      { artifactId: 'a1', path: '/f.txt', nodeId: 'local', name: 'f.txt', size: 10, mimeType: 'text/plain', extra: true },
      { schema: ARTIFACT_REGISTER_META_SCHEMA },
    ),
  )
  assertBoundedPresentationMeta({ id: 'a1', offset: 0, nextOffset: 4096, bytes: 4096 }, { schema: ARTIFACT_READ_META_SCHEMA })
  assertBoundedPresentationMeta({ id: 'a1', offset: 4096, bytes: 0 }, { schema: ARTIFACT_READ_META_SCHEMA })
  assert.throws(() =>
    assertBoundedPresentationMeta({ id: 'a1', offset: 0, nextOffset: 4096, bytes: 4096, chunk: 'duplicated-body' }, { schema: ARTIFACT_READ_META_SCHEMA }),
  )
})

test('KERNEL_TOOL_NAMES is the single source of truth for the 7 foundational kernel tools', { timeout: 60_000 }, () => {
  const expected: readonly KernelToolName[] = [
    'bash',
    'read',
    'write',
    'edit',
    'read_artifact',
    'register_artifact',
    'run_action',
  ]
  assert.deepEqual([...KERNEL_TOOL_NAMES], [...expected])
  assert.equal(new Set(KERNEL_TOOL_NAMES).size, KERNEL_TOOL_NAMES.length)
  for (const name of Object.keys(KERNEL_TOOL_PRESENTATION_META_SCHEMAS)) {
    assert.ok((KERNEL_TOOL_NAMES as readonly string[]).includes(name), `schema tool "${name}" must belong to KERNEL_TOOL_NAMES`)
  }
})
