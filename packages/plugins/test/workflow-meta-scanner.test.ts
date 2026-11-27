/**
 * extractMeta 对象字面量扫描器的行为锁定（纯函数、零 I/O）。
 *
 * 扫描器必须在注释 / 字符串 / 模板 / 正则之外跟踪 `{` `}` 深度，找到字面量的真实闭合位置，
 * 并把 `${` 插值判为非纯字面量。本文件锁定各词法形态下的接受 / 拒绝结果与 vm body 的
 * 字节偏移保持，供扫描器实现重构时回归。
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { extractMeta, hasMetaDeclaration, WorkflowMetaError } from '../src/workflow/dsl/index.js'

const timeout = { timeout: 60_000 } as const

function metaErrorOf(script: string): WorkflowMetaError {
  try {
    extractMeta(script)
  } catch (err) {
    if (err instanceof WorkflowMetaError) return err
    throw err
  }
  throw new Error(`expected extractMeta to reject: ${script}`)
}

describe('meta object literal scanner', () => {
  it('braces inside line / block comments are ignored and the literal closes at the matching brace', timeout, () => {
    const script = [
      'export const meta = {',
      '  // } { unbalanced braces in a line comment',
      '  /* } { and in a block comment */',
      "  name: 'n',",
      '  description: "d",',
      '}',
      'return meta.name',
    ].join('\n')
    const { meta, body } = extractMeta(script)
    assert.equal(meta.name, 'n')
    assert.equal(meta.description, 'd')
    assert.match(body, /\nreturn meta\.name$/)
  })

  it('regex literal: escaped slash and `}` / `/` inside a character class do not close the literal', timeout, () => {
    const script = String.raw`export const meta = { name: "n", description: "d", pattern: /a\/[/}]/g, flags: "x" }`
    const { meta } = extractMeta(script)
    assert.equal(meta.name, 'n')
    assert.equal(meta.description, 'd')
  })

  it('division after an operand is not mistaken for the start of a regex literal', timeout, () => {
    const script = 'export const meta = { name: "n", description: "d", ratio: 4 / 2, half: 8 / 2 }'
    const { meta } = extractMeta(script)
    assert.equal(meta.name, 'n')
    assert.equal(meta.description, 'd')
  })

  it('single-quoted strings: escapes are skipped as a unit and `}` inside them is inert', timeout, () => {
    const script = "export const meta = { name: 'it\\'s', description: 'a\\\\}b' }"
    const { meta } = extractMeta(script)
    assert.equal(meta.name, "it's")
    assert.equal(meta.description, "a\\}b")
  })

  it('a single-quoted string unterminated before the newline ends at the newline (scan still closes; evaluation reports it)', timeout, () => {
    const script = 'export const meta = { name: "n", description: "d", x: \'abc\n}'
    assert.match(metaErrorOf(script).message, /could not be evaluated/)
  })

  it('template literal without interpolation is accepted; `${` (even with nested braces) is rejected as interpolation', timeout, () => {
    const plain = extractMeta('export const meta = { name: `plain`, description: "d" }')
    assert.equal(plain.meta.name, 'plain')
    const nested = 'export const meta = { name: `x${ { a: 1 } }y`, description: "d" }'
    assert.match(metaErrorOf(nested).message, /must not use template interpolation/)
  })

  it('unterminated template / block comment leaves the literal never closed', timeout, () => {
    assert.match(metaErrorOf('export const meta = { name: `n, description: "d" }').message, /never closed/)
    assert.match(metaErrorOf('export const meta = { name: "n", description: "d" /* }').message, /never closed/)
  })

  it('a `meta` declaration quoted inside a doc comment is skipped; only a real declaration counts', timeout, () => {
    const docOnly = '/**\n * export const meta = { name: "doc", description: "x" }\n */\nreturn 1'
    assert.equal(hasMetaDeclaration(docOnly), false)
    assert.match(metaErrorOf(docOnly).message, /must begin with `export const meta/)
    const script = `${docOnly.slice(0, -'return 1'.length)}export const meta = { name: "real", description: "d" }\nreturn meta.name`
    assert.equal(hasMetaDeclaration(script), true)
    assert.equal(extractMeta(script).meta.name, 'real')
  })

  it('the vm body keeps every byte offset: only the `export` keyword is blanked', timeout, () => {
    const script = '// lead\nexport const meta = { name: "n", description: "d" }\nreturn meta.name'
    const { body } = extractMeta(script)
    assert.equal(body.length, script.length)
    assert.equal(body.slice(8, 14), '      ')
    assert.equal(body.slice(14), script.slice(14))
  })
})
