import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ARTIFACT_READ_META_SCHEMA,
  ARTIFACT_REGISTER_META_SCHEMA,
  BASH_TOOL_META_SCHEMA,
  EDIT_TOOL_RESULT_SCHEMA,
  HelmxError,
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
  validateOrThrow,
  type EditToolResult,
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
  for (const value of invalid) assert.throws(() => validate(value), /invalid edit diff result/)
})

test('edit presentation boundary rejects excess rows and over-long row text', { timeout: 60_000 }, () => {
  const row = { kind: 'add', newLine: 1, text: 'line' }
  assert.throws(
    () => validate({ ...result(), diff: { ...result().diff, rows: Array.from({ length: TOOL_DIFF_MAX_ROWS + 1 }, () => row) } }),
    /invalid edit diff result/,
  )
  assert.throws(
    () => validate({ ...result(), diff: { ...result().diff, rows: [{ ...row, text: 'x'.repeat(TOOL_DIFF_MAX_ROW_CHARS + 1) }] } }),
    /invalid edit diff result/,
  )
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
  assertBoundedPresentationMeta({ id: 'a1', offset: 0, nextOffset: 4096, bytes: 4096 }, { schema: ARTIFACT_READ_META_SCHEMA })
  assertBoundedPresentationMeta({ id: 'a1', offset: 4096, bytes: 0 }, { schema: ARTIFACT_READ_META_SCHEMA })
})
