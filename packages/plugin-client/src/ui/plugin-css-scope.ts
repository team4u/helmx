/**
 * Zero-specificity attribute-based CSS scoping for Helmx plugin stylesheets.
 *
 * Design rationale (synchronized host + plugin cascade contract):
 * - Host stylesheets (`packages/web/src/styles/*.css`) are unlayered. Putting
 *   only plugin CSS inside `@layer` would invert cascade priority so unlayered
 *   host rules unconditionally override plugin overrides regardless of
 *   specificity.
 * - Instead, plugin UI roots (`PluginScope`, `Screen`) and all Radix portal
 *   surfaces (`Dialog`, `AlertDialog`, `Popover`, `Select`, `DropdownMenu`,
 *   `Tooltip`) stamp `data-plugin-id="<id>"`, and plugin stylesheets are scoped
 *   under `:where([data-plugin-id="<id>"])`.
 * - Because `:where(...)` contributes (0,0,0) specificity, scoping preserves
 *   every intra-plugin and host-vs-plugin specificity relationship verbatim
 *   while guaranteeing strict cross-plugin and plugin-to-host isolation across
 *   both inline subtrees and portalled overlays.
 */

const PASS_THROUGH_AT_RULES = new Set([
  'keyframes',
  '-webkit-keyframes',
  '-moz-keyframes',
  'font-face',
  'property',
  'page',
  'counter-style',
  'font-palette-values',
])

const RECURSIVE_AT_RULES = new Set([
  'media',
  'supports',
  'container',
  'layer',
  'scope',
  'starting-style',
  'document',
  '-moz-document',
])

function escapeCssAttrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Splits a selector list by top-level commas, respecting quotes, parens, brackets, and comments. */
function splitSelectorList(selectorText: string): string[] {
  const parts: string[] = []
  let start = 0
  let parenDepth = 0
  let bracketDepth = 0
  let quote: string | null = null

  for (let i = 0; i < selectorText.length; i++) {
    const ch = selectorText[i]!
    if (quote !== null) {
      if (ch === '\\') {
        i++
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '/' && selectorText[i + 1] === '*') {
      const end = selectorText.indexOf('*/', i + 2)
      if (end === -1) break
      i = end + 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(') {
      parenDepth++
      continue
    }
    if (ch === ')') {
      if (parenDepth > 0) parenDepth--
      continue
    }
    if (ch === '[') {
      bracketDepth++
      continue
    }
    if (ch === ']') {
      if (bracketDepth > 0) bracketDepth--
      continue
    }
    if (ch === ',' && parenDepth === 0 && bracketDepth === 0) {
      parts.push(selectorText.slice(start, i))
      start = i + 1
    }
  }
  parts.push(selectorText.slice(start))
  return parts
}

/** Rewrites one single selector so it matches both inline descendants and self-stamped portal roots. */
function scopeSingleSelector(rawSelector: string, scopeAttr: string): string {
  const trimmed = rawSelector.trim()
  if (trimmed === '') return ''
  // Idempotent: already scoped for data-plugin-id.
  if (trimmed.includes('[data-plugin-id=')) return trimmed

  // Strip leading comments while preserving them in output? Comments are handled before splitting.
  // :root / :host / html / body map onto the plugin scope anchor itself so plugin
  // custom properties or base resets cannot leak to the host document.
  if (/^(:root|:host|html|body)$/i.test(trimmed)) {
    return scopeAttr
  }
  const rootPrefix = trimmed.match(/^(:root|:host|html|body)(?=[\s>+~.:[#]|$)(.*)$/i)
  if (rootPrefix !== null) {
    const rest = rootPrefix[2] ?? ''
    return `${scopeAttr}${rest}`
  }

  // Universal selector only matches descendants inside the plugin subtree.
  if (trimmed === '*' || /^\*(?=[\s>+~])/.test(trimmed)) {
    return `${scopeAttr} ${trimmed}`
  }

  // Type selector at start (e.g. `button.foo`, `table td`): place `:where(...)`
  // AFTER the tag name for the self-match variant (`button:where([...]).foo`).
  const leadingTag = trimmed.match(/^([a-zA-Z_-][a-zA-Z0-9_-]*)(.*)$/)
  if (leadingTag !== null) {
    const tag = leadingTag[1]!
    const rest = leadingTag[2] ?? ''
    return `${scopeAttr} ${trimmed}, ${tag}${scopeAttr}${rest}`
  }

  // Class / id / attribute / pseudo selector (e.g. `.drawer`, `.card:hover`, `[data-x]`):
  // match both descendants inside PluginScope and self-stamped portal roots (DialogContent / Screen).
  return `${scopeAttr} ${trimmed}, ${scopeAttr}${trimmed}`
}

function scopeSelectorList(selectorText: string, scopeAttr: string): string {
  // Preserve leading/trailing whitespace & strip inline comments cleanly.
  const withoutComments = selectorText.replace(/\/\*[\s\S]*?\*\//g, '').trim()
  if (withoutComments === '') return selectorText
  const scoped = splitSelectorList(withoutComments)
    .map((part) => scopeSingleSelector(part, scopeAttr))
    .filter((part) => part.length > 0)
  return scoped.join(', ')
}

/** Finds the matching `}` for the `{` at `openIndex`, respecting strings and comments. */
function findMatchingBrace(css: string, openIndex: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = openIndex; i < css.length; i++) {
    const ch = css[i]!
    if (quote !== null) {
      if (ch === '\\') {
        i++
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      if (end === -1) return css.length - 1
      i = end + 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return css.length - 1
}

function scopeBlock(css: string, scopeAttr: string): string {
  let out = ''
  let i = 0
  const len = css.length

  while (i < len) {
    // Copy whitespace verbatim.
    if (/\s/.test(css[i]!)) {
      out += css[i]!
      i++
      continue
    }
    // Copy comments verbatim.
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      if (end === -1) {
        out += css.slice(i)
        break
      }
      out += css.slice(i, end + 2)
      i = end + 2
      continue
    }

    // Scan prelude until `{` or `;` (respecting strings/comments).
    const preludeStart = i
    let quote: string | null = null
    let delimiter = ''
    while (i < len) {
      const ch = css[i]!
      if (quote !== null) {
        if (ch === '\\') {
          i += 2
          continue
        }
        if (ch === quote) quote = null
        i++
        continue
      }
      if (ch === '/' && css[i + 1] === '*') {
        const end = css.indexOf('*/', i + 2)
        if (end === -1) {
          i = len
          break
        }
        i = end + 2
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        i++
        continue
      }
      if (ch === '{' || ch === ';') {
        delimiter = ch
        break
      }
      i++
    }

    const prelude = css.slice(preludeStart, i)
    if (delimiter === ';') {
      // Statement at-rule (e.g. `@charset`, `@import`, `@layer foo;`)
      out += `${prelude};`
      i++
      continue
    }
    if (delimiter !== '{') {
      out += prelude
      break
    }

    const closeIndex = findMatchingBrace(css, i)
    const body = css.slice(i + 1, closeIndex)
    const trimmedPrelude = prelude.replace(/\/\*[\s\S]*?\*\//g, '').trim()

    if (trimmedPrelude.startsWith('@')) {
      const atNameMatch = trimmedPrelude.match(/^@([a-zA-Z_-]+)/)
      const atName = (atNameMatch?.[1] ?? '').toLowerCase()
      if (PASS_THROUGH_AT_RULES.has(atName)) {
        out += `${prelude}{${body}}`
      } else if (RECURSIVE_AT_RULES.has(atName)) {
        out += `${prelude}{${scopeBlock(body, scopeAttr)}}`
      } else {
        // Unknown block at-rule: leave body untouched rather than corrupting syntax.
        out += `${prelude}{${body}}`
      }
    } else {
      const scopedPrelude = scopeSelectorList(prelude, scopeAttr)
      out += `${scopedPrelude} {${body}}`
    }

    i = closeIndex + 1
  }

  return out
}

/**
 * Scope a plugin's stylesheet under `:where([data-plugin-id="<pluginId>"])`.
 * Pure, idempotent, zero-specificity-overhead, and safe for `@media`,
 * `@supports`, `@container`, `@keyframes`, `@font-face`, and portalled roots.
 */
export function scopePluginCss(css: string, pluginId: string): string {
  if (css.trim() === '' || pluginId.trim() === '') return css
  const scopeAttr = `:where([data-plugin-id="${escapeCssAttrValue(pluginId)}"])`
  return scopeBlock(css, scopeAttr)
}
