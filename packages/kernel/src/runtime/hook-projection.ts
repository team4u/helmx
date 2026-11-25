/**
 * `before_turn` prompt section and tool declaration projection helpers (rewriting SDK leading system messages).
 */
import type { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import { HelmxError } from '@helmx/protocol'

/** Extract currently effective system sections from model messages (combining leading declaration and subsequent patches). */
export function systemSectionsOf(messages: ReadonlyArray<{ role?: string; sections?: unknown }>): Array<{ id: string; text: string }> {
  const sections = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'system' || message.sections === undefined) continue
    if (message.sections === null || typeof message.sections !== 'object') continue
    for (const [key, value] of Object.entries(message.sections as Record<string, unknown>)) {
      if (value === null) sections.delete(key)
      else if (typeof value === 'string') sections.set(key, value)
    }
  }
  return [...sections.entries()].map(([id, text]) => ({ id, text }))
}

/**
 * Project prompt metadata for final scoped active tools in `before_turn`:
 * - `prompt.tools.<name>`: full paragraph per tool (`promptSnippet`);
 * - `prompt.tools.guidelines`: shared section aggregating all `promptGuidelines`;
 * - Overwrites stale same-named sections cleanly (disabled/stripped tools leave no phantom prompts); empty metadata
 *   produces empty projection (clears all stale managed sections); returns original reference when unchanged.
 */
export function projectToolPromptSections(
  sections: ReadonlyArray<{ id: string; text: string }>,
  tools: ReadonlyArray<{ name: string; promptSnippet?: string; promptGuidelines?: string[] }>,
): Array<{ id: string; text: string }> {
  const snippets = tools.filter((t) => t.promptSnippet !== undefined)
  const guidelines = tools.filter((t) => t.promptGuidelines !== undefined)
  const desired = new Map<string, string>()
  for (const tool of snippets) {
    desired.set(`prompt.tools.${tool.name}`, tool.promptSnippet!)
  }
  if (guidelines.length > 0) {
    const lines = guidelines.flatMap((tool) => tool.promptGuidelines!.map((item) => `- ${tool.name}: ${item}`))
    desired.set('prompt.tools.guidelines', `Available tool guidelines:\n${lines.join('\n')}`)
  }
  const isManaged = (id: string) =>
    id === 'prompt.tools.guidelines' || id.startsWith('prompt.tools.')
  let changed = false
  const out: Array<{ id: string; text: string }> = []
  for (const section of sections) {
    if (isManaged(section.id)) {
      const next = desired.get(section.id)
      if (next !== undefined) {
        out.push({ id: section.id, text: next })
        desired.delete(section.id)
        if (next !== section.text) changed = true
      } else {
        changed = true // remove phantom section
      }
      continue
    }
    out.push(section)
  }
  for (const [id, text] of desired) {
    out.push({ id, text })
    changed = true
  }
  return changed ? out : (sections as Array<{ id: string; text: string }>)
}

/**
 * Boundary validation for full `before_turn` `messages` replacement (prevents system header corruption and history fabrication):
 * - Must be a non-empty array whose first element is a `system` message (SDK replay relies on leading system message);
 * - Base content of leading system message must match original (`sections`/`toolsRemoved`/`toolsAdded` declarations
 *   may change, but base prompt rules and body must not be overwritten);
 * - History starting at the first non-system message must stay intact in original order (appending after is allowed;
 *   truncating/rewriting/fabricating history is forbidden — use rewrite/reset channels for truncation).
 * Violations fail explicitly with `invalid_hook_result` rather than silently accepting broken rewrites.
 */
export function assertSafeMessageSurgery(
  original: ReadonlyArray<Record<string, unknown>>,
  replacement: unknown,
): Array<Record<string, unknown>> {
  const fail = (detail: string): HelmxError =>
    new HelmxError('invalid_hook_result', `before_turn messages rewrite out of bounds: ${detail}`, 500)
  if (!Array.isArray(replacement) || replacement.length === 0) {
    throw fail('must be a non-empty message array')
  }
  const lead = replacement[0]!
  if (lead['role'] !== 'system') {
    throw fail('first message must remain system (SDK replay mechanism relies on a leading system message)')
  }
  if (original.length === 0 || original[0]!['role'] !== 'system') {
    throw fail('original request is missing a leading system message (unexpected kernel state; rewrite rejected)')
  }
  if (contentTextOf(original[0]!) !== contentTextOf(lead)) {
    throw fail('leading system message base content was overwritten (base formatting and body are immutable; update sections/tools via declarations)')
  }
  // Preserve history: the subsequence starting at the first non-system message must appear verbatim in replacement (prefix aligned).
  let firstNonSystem = 0
  while (firstNonSystem < original.length && original[firstNonSystem]!['role'] === 'system') firstNonSystem += 1
  const historyLen = original.length - firstNonSystem
  const preservedHistory = replacement.slice(firstNonSystem, firstNonSystem + historyLen)
  if (historyLen > 0) {
    for (let i = 0; i < historyLen; i += 1) {
      if (preservedHistory[i] !== original[firstNonSystem + i]!) {
        throw fail('historical messages may only be appended after; truncating, rewriting, or fabricating history is not allowed (use rewrite/reset channels for truncation)')
      }
    }
  }
  return replacement as Array<Record<string, unknown>>
}

/** Base text content of a system message (string or concatenated text blocks, matching SDK replay extraction). */
function contentTextOf(message: Record<string, unknown>): string {
  const content = message['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

export function sectionsEqual(a: Array<{ id: string; text: string }>, b: Array<{ id: string; text: string }>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.id !== b[i]!.id || a[i]!.text !== b[i]!.text) return false
  }
  return true
}

/**
 * Replace leading system message `sections` wholesale with `desired` (preserving base content).
 * Subsequent system message section patches are folded into `desired`, stripping old patches so replay cannot override.
 */
export function withSections(
  messages: ReadonlyArray<Record<string, unknown>>,
  desired: Array<{ id: string; text: string }>,
): Array<Record<string, unknown>> {
  if (messages.length === 0) return [...messages]
  const out: Array<Record<string, unknown>> = [...messages]
  const lead = out[0]!
  if (lead['role'] !== 'system') return out
  const previous = lead['sections']
  const previousKeys =
    previous !== null && typeof previous === 'object'
      ? Object.keys(previous as Record<string, unknown>)
      : []
  // New declarations; old keys absent from the new set are removed with `null` (replay semantics).
  const next: Record<string, string | null> = {}
  for (const [i, section] of desired.entries()) {
    void i
    next[section.id] = section.text
  }
  for (const key of previousKeys) {
    if (!(key in next)) next[key] = null
  }
  out[0] = { ...lead, sections: next }
  for (let i = 1; i < out.length; i += 1) {
    const message = out[i]!
    if (message['role'] !== 'system' || message['sections'] === undefined) continue
    const { sections: _sections, ...rest } = message
    out[i] = rest
  }
  return out
}

/**
 * Rewrite tool declarations: attach `toolsRemoved`/`toolsAdded` declarations to the leading system message.
 * Parsed on the model side by pi-ai replay (`getCurrentTools`), taking effect immediately on the next round.
 */
export function withToolDeclarations(
  messages: ReadonlyArray<Record<string, unknown>>,
  declared: Set<string>,
  tools: ReturnType<typeof getCurrentTools>,
): Array<Record<string, unknown>> {
  const available = new Map(tools.map((tool) => [tool.name, tool]))
  const added: Array<Record<string, unknown>> = []
  for (const name of declared) {
    const tool = available.get(name)
    if (!tool) throw new HelmxError('unknown_tool', `before_turn selected unregistered tool: ${name}`, 500)
    added.push({ ...tool })
  }
  if (messages.length === 0 || messages[0]!['role'] !== 'system') return [...messages]
  const lead = messages[0]!
  // Full redeclaration: remove stale declarations then add new set (equivalent replay, avoids order drift).
  const next: Record<string, unknown> = { ...lead }
  const sections = lead['sections']
  next['sections'] =
    sections !== null && typeof sections === 'object'
      ? { ...(sections as Record<string, unknown>) }
      : {}
  next['toolsRemoved'] = currentToolNames(messages).filter((name) => declared.has(name) === false).map((name) => ({ name }))
  next['toolsAdded'] = added
  return [{ ...next }, ...messages.slice(1)]
}

/** List current tool names from replay messages. */
function currentToolNames(messages: ReadonlyArray<Record<string, unknown>>): string[] {
  const names = new Set<string>()
  for (const message of messages) {
    if (message['role'] !== 'system') continue
    for (const tool of message['toolsAdded'] as Array<{ name?: string }> | undefined ?? []) {
      if (typeof tool?.name === 'string') names.add(tool.name)
    }
    for (const ref of message['toolsRemoved'] as Array<{ name?: string }> | undefined ?? []) {
      if (typeof ref?.name === 'string') names.delete(ref.name)
    }
  }
  return [...names]
}
