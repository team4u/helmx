/**
 * Regression tests for redaction and streaming redaction: structured JSON redaction and SecretStash chunk boundaries.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { redactJsonValue } from '../src/redact.js'
import { SecretStash } from '../src/services/secret-stash.js'

test('structured redaction covers values and keys with quotes/newlines while preserving existing placeholders', { timeout: 60_000 }, () => {
  const stash = new SecretStash()
  const secret = ['example"value', 'next line'].join('\n')
  stash.addRedaction(secret)
  const marker = '[REDACTED]'
  const result = redactJsonValue({ [secret]: { list: [secret, marker] } }, (text) => stash.redact(text))
  assert.deepEqual(result, { [marker]: { list: [marker, marker] } })
  assert.equal(JSON.stringify(result).includes('example'), false)
})

test('structured output rejects cycles, non-JSON values, and post-redaction key collisions', { timeout: 60_000 }, () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  for (const value of [cyclic, { value: undefined }, [NaN], new Map(), Array(1)]) {
    assert.throws(() => redactJsonValue(value, (text) => text))
  }
  assert.throws(() => redactJsonValue({ first: 1, second: 2 }, () => 'same'), /Redacted output fields collide/)
})

test('streaming redaction covers secrets across chunks, overlapping prefixes, and former cut boundaries', { timeout: 60_000 }, () => {
  for (const secret of ['ababa', '{{SECRET_mvch3tgr}}', '😀private😀', 'A'.repeat(5_000) + 'Z']) {
    const stash = new SecretStash()
    stash.addRedaction(secret)
    const input = 'padding'.repeat(600) + secret + 'after'.repeat(900)
    const sizes = [1, 2, 13, 4_096]
    for (const size of sizes) {
      const stream = stash.createStreamingRedactor()
      let actual = ''
      for (let offset = 0; offset < input.length; offset += size) actual += stream.push(input.slice(offset, offset + size))
      actual += stream.flush()
      assert.equal(actual, stash.redact(input), `secret length ${secret.length}, chunk ${size}`)
      assert.equal(actual.includes(secret), false)
    }
  }
})

test('secrets sharing a prefix preserve longest-match literal redaction semantics', { timeout: 60_000 }, () => {
  const stash = new SecretStash()
  stash.addRedaction('abc')
  stash.addRedaction('abcdef')
  const stream = stash.createStreamingRedactor()
  const output = stream.push('abc') + stream.push('def-more') + stream.flush()
  assert.equal(output, stash.redact('abcdef-more'))
})

test('ordinary streaming output flushes without waiting for fixed 4KiB buffer while redacting managed tokens across chunks', { timeout: 60_000 }, () => {
  const stash = new SecretStash()
  stash.addRedaction('managed-credential')
  const stream = stash.createStreamingRedactor()
  assert.equal(stream.push('progress\n'), 'progress\n')
  assert.equal(stream.push('managed-'), '')
  assert.equal(stream.push('credential'), '[REDACTED]')
  assert.equal(stream.flush(), '')
})

test('SecretStash cached regex invalidates cleanly on distinct add, duplicate add, disposer removal, and clear', { timeout: 60_000 }, () => {
  const stash = new SecretStash()
  assert.equal(stash.redact('hello world'), 'hello world')

  // Distinct keys + duplicate reference count for first key
  const d1 = stash.addRedaction('alpha-secret')
  const d1Dup = stash.addRedaction('alpha-secret')
  const d2 = stash.addRedaction('beta-secret')
  assert.equal(stash.redact('alpha-secret and beta-secret'), '[REDACTED] and [REDACTED]')

  // Removing one duplicate ref keeps alpha-secret active
  d1()
  assert.equal(stash.redact('alpha-secret and beta-secret'), '[REDACTED] and [REDACTED]')

  // Removing last ref for alpha-secret invalidates regex immediately while preserving beta-secret
  d1Dup()
  assert.equal(stash.redact('alpha-secret and beta-secret'), 'alpha-secret and [REDACTED]')

  // Streaming redactor created after key mutation observes the updated compiled pattern
  const stream = stash.createStreamingRedactor()
  assert.equal(stream.push('alpha-secret beta-') + stream.push('secret') + stream.flush(), 'alpha-secret [REDACTED]')

  // Removing last remaining key or calling clear() restores pass-through
  d2()
  assert.equal(stash.redact('beta-secret'), 'beta-secret')
  stash.addRedaction('gamma-secret')
  assert.equal(stash.redact('gamma-secret'), '[REDACTED]')
  stash.clear()
  assert.equal(stash.redact('gamma-secret'), 'gamma-secret')
})
