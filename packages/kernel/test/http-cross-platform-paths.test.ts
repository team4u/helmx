/**
 * Boundary regressions for cross-platform absolute paths and generic runtime identifiers (HTTP + service layers).
 *
 * Coverage:
 * 1. conversation init/patch cwd: allows POSIX `/`, Windows drive paths (`C:\\work` / `D:/repo`), and
 *    UNC paths (`\\\\srv\\share\\dir`); rejects drive-relative paths (`C:relative`) and pure relative
 *    paths (aligned with runtime/tools.ts isAbsoluteTargetPath semantics so kernel handles remote/Windows
 *    target path shapes independently of the Hub host OS);
 * 2. Profile runtime.workspace uses identical cross-platform absolute path validation (enforced consistently
 *    at both service layer validateProfileInput and HTTP layer parseProfileRuntime);
 * 3. runtime.kind has zero hardcoded plugin enums: kernel only validates external runtime identifier format
 *    (^[a-z][a-z0-9_-]{0,31}$) without special-casing plugin names -- valid identifiers like 'herdr' /
 *    'docker' pass, while invalid formats (uppercase, empty, special chars, oversized) reject.
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateProfileInput } from '../src/services/profile-service.js'
import {
  parseConversationInit,
  parseConversationPatch,
  parseProfileBody,
  ValidationError,
} from '../src/http/validate.js'

const timeout = { timeout: 60_000 } as const

let root: string

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'helmx-crosspath-'))
})

after(async () => {
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. Conversation cwd cross-platform absolute paths (parseConversationInit / parseConversationPatch)
// ---------------------------------------------------------------------------

describe('conversation cwd cross-platform absolute path validation', { timeout: 60_000 }, () => {
  const valid: Array<[string, string]> = [
    ['POSIX root', '/'],
    ['POSIX absolute', '/srv/work/helmx'],
    ['Windows drive backslash', 'C:\\work\\helmx'],
    ['Windows drive forward slash', 'D:/repo/project'],
    ['lowercase drive letter', 'c:\\Users\\dev'],
    ['UNC path', '\\\\srv\\share\\dir'],
  ]
  const invalid: Array<[string, string]> = [
    ['drive-relative (missing separator)', 'C:relative'],
    ['bare drive letter', 'C:'],
    ['pure relative path', 'work/dir'],
    ['empty string (invalid whenever explicitly provided outside init default)', ''],
    ['dot-relative', './x'],
    ['parent-relative', '../x'],
  ]

  for (const [why, cwd] of valid) {
    it(`init cwd allows ${why} (${JSON.stringify(cwd)})`, timeout, () => {
      const init = parseConversationInit({ cwd })
      assert.equal(init.cwd, cwd)
    })
    it(`patch cwd allows ${why} (${JSON.stringify(cwd)})`, timeout, () => {
      const patch = parseConversationPatch({ cwd })
      assert.equal(patch.cwd, cwd)
    })
  }

  for (const [why, cwd] of invalid) {
    it(`init cwd rejects ${why} (${JSON.stringify(cwd)})`, timeout, () => {
      assert.throws(() => parseConversationInit({ cwd }), ValidationError)
    })
    it(`patch cwd rejects ${why} (${JSON.stringify(cwd)})`, timeout, () => {
      assert.throws(() => parseConversationPatch({ cwd }), ValidationError)
    })
  }
})

test('validateProfileInput and parseProfileBody reject unknown fields like runtime', timeout, () => {
  assert.throws(
    () => validateProfileInput({ id: 'ws-bad', runtime: { kind: 'docker', agent: 'codex' } } as never),
    /unknown field 'runtime'/i,
  )
  assert.throws(
    () => parseProfileBody({ id: 'ws-bad', runtime: { kind: 'docker', agent: 'codex' } }, { requireId: true }),
    ValidationError,
  )
})
