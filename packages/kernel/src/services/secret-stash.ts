/**
 * In-memory SecretStash: global value-based redactor for managed tokens and host/plugin secrets.
 * Values registered via `addRedaction` are replaced with `[REDACTED]` across all runtime outputs,
 * streaming chunks, artifacts, events, and FTS indexes. Multiple registrations for the same value
 * stack and redaction stops only once all returned disposers are called; `clear()` resets everything.
 *
 * Honest boundary (explicitly stated): redaction cannot prevent shell commands or in-process plugin
 * code from reading process environment variables or memory—that is an inherent privilege of trusted
 * code, and this module does not promise zero leakage.
 */

export const REDACTED_MARKER = '[REDACTED]'

export class SecretStash {
  /** Global value-based redactions: value -> reference count (multiple registrations stack until all are disposed). */
  private readonly globalRedactions = new Map<string, number>()
  private redactionEpoch = 0
  /** Lazily compiled global redaction regex; invalidated whenever the distinct key set changes. */
  private compiledPattern: RegExp | undefined

  /**
   * Register a global value-based redaction: `redact()` replaces this value with `[REDACTED]`.
   * The same value can be registered multiple times and stops being redacted only once all returned
   * disposers have been called.
   */
  addRedaction(value: string): () => void {
    if (typeof value !== 'string' || value === '') throw new Error('addRedaction requires a non-empty string')
    const prev = this.globalRedactions.get(value) ?? 0
    this.globalRedactions.set(value, prev + 1)
    if (prev === 0) this.compiledPattern = undefined
    const epoch = this.redactionEpoch
    let removed = false
    return () => {
      if (removed || epoch !== this.redactionEpoch) return
      removed = true
      const count = this.globalRedactions.get(value) ?? 0
      if (count <= 1) {
        this.globalRedactions.delete(value)
        this.compiledPattern = undefined
      } else {
        this.globalRedactions.set(value, count - 1)
      }
    }
  }

  private getCompiledPattern(): RegExp | undefined {
    if (this.globalRedactions.size === 0) return undefined
    if (this.compiledPattern === undefined) {
      const escaped = [...this.globalRedactions.keys()]
        .sort((a, b) => b.length - a.length)
        .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      this.compiledPattern = new RegExp(`\\[REDACTED\\]|${escaped.join('|')}`, 'g')
    }
    this.compiledPattern.lastIndex = 0
    return this.compiledPattern
  }

  /** Replace all registered secret values with `[REDACTED]`; existing `[REDACTED]` markers stay intact. */
  redact(text: string): string {
    if (text === '' || this.globalRedactions.size === 0) return text
    const pattern = this.getCompiledPattern()
    if (pattern === undefined) return text
    return text.replace(pattern, (match) => (match === REDACTED_MARKER ? match : REDACTED_MARKER))
  }

  /** Streaming redaction: buffers only the longest suffix that could still complete a secret, avoiding splitting matches across chunks. */
  createStreamingRedactor(): { push(text: string): string; flush(): string } {
    let pending = ''
    const prefixes = new Map<string, number[]>()
    const overlap = (value: string, text: string): number => {
      let prefix = prefixes.get(value)
      if (!prefix) {
        prefix = new Array<number>(value.length).fill(0)
        for (let i = 1, j = 0; i < value.length; i++) {
          while (j > 0 && value[i] !== value[j]) j = prefix[j - 1]!
          if (value[i] === value[j]) j++
          prefix[i] = j
        }
        prefixes.set(value, prefix)
      }
      let matched = 0
      const tail = value.length > 1 ? text.slice(-(value.length - 1)) : ''
      for (let index = 0; index < tail.length; index++) {
        const char = tail[index]!
        while (matched > 0 && char !== value[matched]) matched = prefix[matched - 1]!
        if (char === value[matched]) matched++
        if (matched === value.length) matched = prefix[matched - 1]!
      }
      return matched
    }
    return {
      push: (text) => {
        pending += text
        let keep = 0
        for (const value of this.globalRedactions.keys()) if (value) keep = Math.max(keep, overlap(value, pending))
        const last = pending.charCodeAt(pending.length - 1)
        if (last >= 0xd800 && last <= 0xdbff) keep = Math.max(keep, 1)
        let cut = pending.length - keep
        const pattern = this.getCompiledPattern()
        if (pattern !== undefined) {
          for (const match of pending.matchAll(pattern)) {
            if (match.index < cut && match.index + match[0].length > cut) { cut = match.index; break }
            if (match.index >= cut) break
          }
        }
        const safe = this.redact(pending.slice(0, cut))
        pending = pending.slice(cut)
        return safe
      },
      flush: () => {
        const safe = this.redact(pending)
        pending = ''
        return safe
      },
    }
  }

  /** Clear all global redaction registrations and invalidate existing disposers. */
  clear(): void {
    this.globalRedactions.clear()
    this.compiledPattern = undefined
    this.redactionEpoch += 1
  }
}
