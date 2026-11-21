/**
 * Pure unit tests for command-palette-model:
 * - multi-word AND matching & deterministic tiered ranking
 * - #id & numeric id matching (without #4 -> #40 substring collision)
 * - deduplication between local conversations and title-only / duplicate FTS hits
 * - empty-state grouping
 * - focused panel vs Mod+Enter split navigation resolution
 * - stable selection preservation & layered Escape resolution
 * - honest snippet highlight rendering (highlights: [] vs undefined vs explicit spans)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary } from '@helmx/protocol'
import {
  buildPaletteRows,
  findQueryTokenRanges,
  normalizeHighlightSpans,
  parseNumericIdQuery,
  resolvePaletteEscapeAction,
  resolveRowNavigation,
  resolveSelectedIndex,
  resolveSnippetHighlightSegments,
  resolveTitleHighlightSegments,
  splitTextByHighlightRanges,
  type PaletteCommandRow,
  type PaletteSearchHit,
  type PaletteSearchHitRow,
} from '../src/modals/command-palette-model.js'

function conv(overrides: Partial<ConversationSummary> & { id: number }): ConversationSummary {
  return {
    title: `Conversation ${overrides.id}`,
    profileId: 'assistant',
    model: 'anthropic/claude-sonnet-4',
    thinkingLevel: 'medium',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 1,
    nodeId: 'local',
    cwd: '/tmp/work',
    createdAt: 1000,
    updatedAt: 2000,
    tags: [],
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    ...overrides,
  }
}

function makeConvRow(c: ConversationSummary): PaletteSearchHitRow {
  return {
    kind: 'search-hit',
    id: `conv:${c.id}`,
    group: 'recent',
    conv: c,
    isLocalConversation: true,
    hit: {
      conversationId: c.id,
      title: c.title,
      entryId: '',
      snippet: `Conversation #${c.id} / ${c.profileId}`,
    },
  }
}

test('parseNumericIdQuery distinguishes #id, positive integer, and non-id inputs', { timeout: 60_000 }, () => {
  assert.deepEqual(parseNumericIdQuery('#42'), { id: 42, explicitHash: true })
  assert.deepEqual(parseNumericIdQuery('  42 '), { id: 42, explicitHash: false })
  assert.equal(parseNumericIdQuery('#0'), null)
  assert.equal(parseNumericIdQuery('0'), null)
  assert.equal(parseNumericIdQuery('42 deploy'), null)
  assert.equal(parseNumericIdQuery('abc'), null)
})

test('buildPaletteRows empty state emits non-empty groups in deterministic order', { timeout: 60_000 }, () => {
  const ctx: PaletteCommandRow = {
    kind: 'command',
    id: 'builtin:new-conversation',
    group: 'context',
    title: 'New conversation',
    target: { kind: 'profiles' },
  }
  const nav: PaletteCommandRow = {
    kind: 'command',
    id: 'builtin:open-overview',
    group: 'navigation',
    title: 'Open conversation overview',
    target: { kind: 'overview' },
  }
  const cmd: PaletteCommandRow = {
    kind: 'command',
    id: 'builtin:toggle-theme',
    group: 'commands',
    title: 'Switch to dark mode',
  }
  const result = buildPaletteRows({
    query: '   ',
    contextCommands: [ctx],
    recentConversations: [],
    navigationCommands: [nav],
    utilityCommands: [cmd],
    conversations: [],
    ftsHits: [],
    makeConversationRow: makeConvRow,
  })
  assert.deepEqual(
    result.sections.map((s) => s.key),
    ['context', 'navigation', 'commands'],
  )
  assert.deepEqual(
    result.rows.map((r) => r.id),
    ['builtin:new-conversation', 'builtin:open-overview', 'builtin:toggle-theme'],
  )
})

test('buildPaletteRows enforces multi-word AND matching and tiered ranking', { timeout: 60_000 }, () => {
  const commands: PaletteCommandRow[] = [
    {
      kind: 'command',
      id: 'builtin:toggle-theme',
      group: 'commands',
      title: 'Switch to dark mode',
      keywords: ['theme', 'dark'],
    },
    {
      kind: 'command',
      id: 'builtin:open-plugins',
      group: 'navigation',
      title: 'Open plugins center',
      keywords: ['plugin', 'settings'],
      target: { kind: 'plugins' },
    },
    {
      kind: 'command',
      id: 'profile:coder',
      group: 'navigation',
      title: 'Open agent: Coder',
      hint: 'coder',
      keywords: ['agent', 'coder'],
      target: { kind: 'agent', profileId: 'coder' },
    },
  ]
  const conversations = [
    conv({ id: 4, title: 'Fix auth bug', profileId: 'coder', updatedAt: 5000 }),
    conv({ id: 40, title: 'Deploy notes', profileId: 'assistant', updatedAt: 6000 }),
    conv({ id: 42, title: 'Dark theme contrast review', profileId: 'coder', updatedAt: 4000 }),
  ]

  // Multi-word AND across title + keyword
  const darkTheme = buildPaletteRows({
    query: 'dark theme',
    contextCommands: [],
    recentConversations: [],
    navigationCommands: [commands[1]!, commands[2]!],
    utilityCommands: [commands[0]!],
    conversations,
    ftsHits: [],
    makeConversationRow: makeConvRow,
  })
  assert.deepEqual(
    darkTheme.rows.map((r) => r.id),
    ['conv:42', 'builtin:toggle-theme'],
  )

  // Multi-word AND with one unmatched token excludes partial matches
  const miss = buildPaletteRows({
    query: 'dark missingtoken',
    contextCommands: [],
    recentConversations: [],
    navigationCommands: [commands[1]!, commands[2]!],
    utilityCommands: [commands[0]!],
    conversations,
    ftsHits: [],
    makeConversationRow: makeConvRow,
  })
  assert.deepEqual(miss.rows, [])

  // #4 matches conversation #4 exactly and never substring-matches #40 or #42
  const hashId = buildPaletteRows({
    query: '#4',
    contextCommands: [],
    recentConversations: [],
    navigationCommands: [commands[1]!, commands[2]!],
    utilityCommands: [commands[0]!],
    conversations,
    ftsHits: [],
    makeConversationRow: makeConvRow,
  })
  assert.deepEqual(
    hashId.rows.map((r) => r.id),
    ['conv:4'],
  )

  // Exact profileId ('coder') ranks agent profile Tier 0 ahead of Tier 3 conversations with profileId='coder'
  const coderQuery = buildPaletteRows({
    query: 'coder',
    contextCommands: [],
    recentConversations: [],
    navigationCommands: [commands[1]!, commands[2]!],
    utilityCommands: [commands[0]!],
    conversations,
    ftsHits: [],
    makeConversationRow: makeConvRow,
  })
  assert.equal(coderQuery.rows[0]?.id, 'profile:coder')
})

test('buildPaletteRows deduplicates FTS title-only hits against local conversations and duplicate entry hits while keeping distinct entryId hits', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 5, title: 'Search refactor', profileId: 'coder', updatedAt: 5000 }),
  ]
  const ftsHits: PaletteSearchHit[] = [
    { conversationId: 5, entryId: '', title: 'Search refactor', snippet: 'Search refactor', highlights: [] },
    { conversationId: 5, entryId: 'e10', title: 'Search refactor', snippet: 'Details about Search refactor', highlights: [{ start: 14, end: 20 }] },
    { conversationId: 5, entryId: 'e10', title: 'Search refactor', snippet: 'Duplicate e10', highlights: [{ start: 0, end: 9 }] },
    { conversationId: 9, entryId: undefined, title: 'Remote conv 9', snippet: 'Title only on non-local conv', highlights: [] },
  ]
  const res = buildPaletteRows({
    query: 'Search',
    contextCommands: [],
    recentConversations: [],
    navigationCommands: [],
    utilityCommands: [],
    conversations,
    ftsHits,
    makeConversationRow: makeConvRow,
  })
  assert.deepEqual(
    res.rows.map((r) => r.id),
    ['conv:5', 'hit:5:e10', 'hit:9:'],
  )
})

test('resolveRowNavigation applies activePanel and Mod+Enter split cleanly without splitting non-navigable commands', { timeout: 60_000 }, () => {
  const navCmd: PaletteCommandRow = {
    kind: 'command',
    id: 'builtin:open-overview',
    group: 'navigation',
    title: 'Open conversation overview',
    target: { kind: 'overview' },
  }
  const actionCmd: PaletteCommandRow = {
    kind: 'command',
    id: 'builtin:toggle-theme',
    group: 'commands',
    title: 'Switch to dark mode',
  }
  const hitRow: PaletteSearchHitRow = {
    kind: 'search-hit',
    id: 'hit:7:e42',
    group: 'recent',
    hit: { conversationId: 7, entryId: 'e42', snippet: 'matched line' },
  }

  assert.deepEqual(resolveRowNavigation(navCmd, 'primary', false), {
    target: { kind: 'overview' },
    split: false,
  })
  assert.deepEqual(resolveRowNavigation(navCmd, 'split', false), {
    target: { kind: 'overview' },
    split: true,
  })
  assert.deepEqual(resolveRowNavigation(navCmd, 'primary', true), {
    target: { kind: 'overview' },
    split: true,
  })
  assert.deepEqual(resolveRowNavigation(hitRow, 'split', false), {
    target: { kind: 'conversation', conversationId: 7 },
    split: true,
    highlightEntryId: 'e42',
  })
  assert.equal(resolveRowNavigation(actionCmd, 'primary', true), null)
})

test('resolveSelectedIndex preserves selectedId across list updates and falls back to 0 or -1', { timeout: 60_000 }, () => {
  const rows: PaletteCommandRow[] = [
    { kind: 'command', id: 'a', group: 'commands', title: 'A' },
    { kind: 'command', id: 'b', group: 'commands', title: 'B' },
    { kind: 'command', id: 'c', group: 'commands', title: 'C' },
  ]
  assert.equal(resolveSelectedIndex(rows, 'b'), 1)
  assert.equal(resolveSelectedIndex(rows, 'missing'), 0)
  assert.equal(resolveSelectedIndex(rows, null), 0)
  assert.equal(resolveSelectedIndex([], 'a'), -1)
})

test('resolvePaletteEscapeAction follows IME -> preview -> query -> close layering', { timeout: 60_000 }, () => {
  assert.equal(resolvePaletteEscapeAction({ isComposing: true, hasPreview: true, query: 'abc' }), 'ignore-ime')
  assert.equal(resolvePaletteEscapeAction({ isComposing: false, hasPreview: true, query: 'abc' }), 'close-preview')
  assert.equal(resolvePaletteEscapeAction({ isComposing: false, hasPreview: false, query: 'abc' }), 'clear-query')
  assert.equal(resolvePaletteEscapeAction({ isComposing: false, hasPreview: false, query: '  ' }), 'clear-query')
  assert.equal(resolvePaletteEscapeAction({ isComposing: false, hasPreview: false, query: '' }), 'close-modal')
})

test('highlight helpers respect explicit highlights, [] honesty, overlaps, and undefined fallback', { timeout: 60_000 }, () => {
  // Invalid/overlapping spans are sanitized cleanly
  assert.deepEqual(
    normalizeHighlightSpans(10, [
      { start: -1, end: 3 },
      { start: 5, end: 5 },
      { start: 4, end: 8 },
      { start: 2, end: 6 },
      { start: 9, end: 20 },
    ]),
    [{ start: 2, end: 8 }],
  )

  // Explicit highlights: [] means title-only hit -> NO fabricated snippet highlights
  assert.deepEqual(resolveSnippetHighlightSegments('deploy config done', [], 'deploy'), [
    { text: 'deploy config done', highlighted: false },
  ])

  // Explicit non-empty highlights slice cleanly
  assert.deepEqual(
    resolveSnippetHighlightSegments('配置中文搜索高亮', [{ start: 2, end: 6 }], '中文搜索'),
    [
      { text: '配置', highlighted: false },
      { text: '中文搜索', highlighted: true },
      { text: '高亮', highlighted: false },
    ],
  )

  // Legacy/stub highlights === undefined falls back to matched query tokens only (never unmatched tokens)
  assert.deepEqual(
    resolveSnippetHighlightSegments('Hello Helmx Search', undefined, 'helmx nonexistent'),
    [
      { text: 'Hello ', highlighted: false },
      { text: 'Helmx', highlighted: true },
      { text: ' Search', highlighted: false },
    ],
  )

  assert.deepEqual(splitTextByHighlightRanges('plain', []), [{ text: 'plain', highlighted: false }])
  assert.deepEqual(findQueryTokenRanges('abc', '   '), [])
  assert.deepEqual(resolveTitleHighlightSegments('Auth Bug #12', 'auth #12'), [
    { text: 'Auth', highlighted: true },
    { text: ' Bug ', highlighted: false },
    { text: '#12', highlighted: true },
  ])
})
