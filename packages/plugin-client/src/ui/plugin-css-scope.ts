/**
 * Layered, zero-specificity CSS scoping for Helmx plugin stylesheets.
 *
 * Design rationale (synchronized host + plugin cascade contract):
 * - Host stylesheets (`packages/web/src/styles.css`) declare the explicit cascade
 *   order `@layer host-base, host-components, plugin-ui;`.
 * - Every plugin stylesheet is wrapped in `@layer plugin-ui { ... }` (keeping any
 *   leading `@charset` / `@import` statements outside per CSS spec) so plugin
 *   overrides predictably win over `host-base` and `host-components` without
 *   `!important` wars.
 * - Plugin UI roots (`PluginScope`, `Screen`) and Radix portal surfaces stamp
 *   `data-plugin-id="<id>"`, and plugin selectors are scoped under
 *   `:where([data-plugin-id="<id>"])` (zero specificity overhead).
 * - `@keyframes` / `@-webkit-keyframes` / `@-moz-keyframes` names and matching
 *   `animation` / `animation-name` references are prefixed per plugin so
 *   identically named animations from different plugins never collide.
 */

const KEYFRAMES_AT_RULES = new Set([
  'keyframes',
  '-webkit-keyframes',
  '-moz-keyframes',
])

const PASS_THROUGH_AT_RULES = new Set([
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

const ANIMATION_PROPERTIES = new Set([
  'animation',
  'animation-name',
  '-webkit-animation',
  '-webkit-animation-name',
  '-moz-animation',
  '-moz-animation-name',
])

const ANIMATION_KEYWORDS = new Set([
  'none',
  'initial',
  'inherit',
  'unset',
  'revert',
  'revert-layer',
  'infinite',
  'normal',
  'reverse',
  'alternate',
  'alternate-reverse',
  'forwards',
  'backwards',
  'both',
  'running',
  'paused',
  'ease',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'linear',
  'step-start',
  'step-end',
  'auto',
])

const PLUGIN_LAYER_NAME = 'plugin-ui'

function escapeCssAttrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function buildKeyframePrefix(pluginId: string): string {
  const slug = pluginId.replace(/[^a-zA-Z0-9-]/g, (ch) => `_${ch.codePointAt(0)!.toString(16)}_`)
  return `helmx-kf-${slug}-`
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

function parseKeyframeName(trimmedPrelude: string): { atRule: string; rawName: string; unquotedName: string; quote: string | null } | null {
  const match = trimmedPrelude.match(/^(@(?:-webkit-|-moz-)?keyframes)\s+(?:"([^"]+)"|'([^']+)'|([a-zA-Z_-][a-zA-Z0-9_-]*))$/i)
  if (match === null) return null
  const atRule = match[1]!
  if (match[2] !== undefined) {
    return { atRule, rawName: `"${match[2]}"`, unquotedName: match[2], quote: '"' }
  }
  if (match[3] !== undefined) {
    return { atRule, rawName: `'${match[3]}'`, unquotedName: match[3], quote: "'" }
  }
  const ident = match[4]!
  return { atRule, rawName: ident, unquotedName: ident, quote: null }
}

function collectKeyframes(css: string, kfPrefix: string, keyframeMap: Map<string, string>): void {
  let i = 0
  const len = css.length

  while (i < len) {
    if (/\s/.test(css[i]!)) {
      i++
      continue
    }
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      if (end === -1) break
      i = end + 2
      continue
    }

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
      i++
      continue
    }
    if (delimiter !== '{') break

    const closeIndex = findMatchingBrace(css, i)
    const body = css.slice(i + 1, closeIndex)
    const trimmedPrelude = prelude.replace(/\/\*[\s\S]*?\*\//g, '').trim()

    if (trimmedPrelude.startsWith('@')) {
      const atName = (trimmedPrelude.match(/^@([a-zA-Z_-]+)/)?.[1] ?? '').toLowerCase()
      if (KEYFRAMES_AT_RULES.has(atName)) {
        const parsed = parseKeyframeName(trimmedPrelude)
        if (parsed !== null) {
          const scopedName = parsed.unquotedName.startsWith(kfPrefix)
            ? parsed.unquotedName
            : `${kfPrefix}${parsed.unquotedName}`
          keyframeMap.set(parsed.unquotedName, scopedName)
        }
      } else if (RECURSIVE_AT_RULES.has(atName)) {
        collectKeyframes(body, kfPrefix, keyframeMap)
      }
    }

    i = closeIndex + 1
  }
}

/** Rewrites matching animation names inside an `animation` / `animation-name` declaration value. */
function rewriteAnimationValue(value: string, keyframeMap: ReadonlyMap<string, string>): string {
  let out = ''
  let i = 0
  let parenDepth = 0
  const len = value.length

  while (i < len) {
    const ch = value[i]!
    if (ch === '/' && value[i + 1] === '*') {
      const end = value.indexOf('*/', i + 2)
      if (end === -1) {
        out += value.slice(i)
        break
      }
      out += value.slice(i, end + 2)
      i = end + 2
      continue
    }
    if (ch === '(') {
      parenDepth++
      out += ch
      i++
      continue
    }
    if (ch === ')') {
      if (parenDepth > 0) parenDepth--
      out += ch
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      let j = i + 1
      while (j < len) {
        if (value[j] === '\\') {
          j += 2
          continue
        }
        if (value[j] === quote) break
        j++
      }
      const raw = value.slice(i, j + 1)
      const inner = value.slice(i + 1, j)
      if (parenDepth === 0 && keyframeMap.has(inner)) {
        out += `${quote}${keyframeMap.get(inner)!}${quote}`
      } else {
        out += raw
      }
      i = j + 1
      continue
    }
    if (parenDepth === 0 && /[a-zA-Z_-]/.test(ch)) {
      const prev = i > 0 ? value[i - 1]! : ''
      let j = i + 1
      while (j < len && /[a-zA-Z0-9_-]/.test(value[j]!)) j++
      const ident = value.slice(i, j)
      const next = j < len ? value[j]! : ''
      // Ignore numeric units (e.g. `1s`, `200ms`), custom properties (`--x`),
      // function names (`cubic-bezier(...)`), and standard animation keywords.
      const isUnit = /[0-9.]/.test(prev)
      const isFunc = next === '('
      if (!isUnit && !isFunc && !ident.startsWith('--') && !ANIMATION_KEYWORDS.has(ident.toLowerCase())) {
        out += keyframeMap.get(ident) ?? ident
      } else {
        out += ident
      }
      i = j
      continue
    }
    out += ch
    i++
  }

  return out
}

/** Rewrites `animation` / `animation-name` declarations inside a style rule declaration block. */
function rewriteAnimationDeclarations(body: string, keyframeMap: ReadonlyMap<string, string>): string {
  if (keyframeMap.size === 0 || !/animation/i.test(body)) return body
  let out = ''
  let i = 0
  const len = body.length

  while (i < len) {
    const start = i
    let quote: string | null = null
    let colonIndex = -1
    let braceDepth = 0
    while (i < len) {
      const ch = body[i]!
      if (quote !== null) {
        if (ch === '\\') {
          i += 2
          continue
        }
        if (ch === quote) quote = null
        i++
        continue
      }
      if (ch === '/' && body[i + 1] === '*') {
        const end = body.indexOf('*/', i + 2)
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
      if (ch === '{') {
        braceDepth++
        i++
        continue
      }
      if (ch === '}') {
        if (braceDepth > 0) braceDepth--
        i++
        continue
      }
      if (braceDepth === 0 && ch === ':' && colonIndex === -1) {
        colonIndex = i
        i++
        continue
      }
      if (braceDepth === 0 && ch === ';') {
        break
      }
      i++
    }

    const end = i < len ? i + 1 : i
    if (colonIndex !== -1) {
      const rawProp = body.slice(start, colonIndex)
      const propName = rawProp.replace(/\/\*[\s\S]*?\*\//g, '').trim().toLowerCase()
      if (ANIMATION_PROPERTIES.has(propName)) {
        const valueSlice = body.slice(colonIndex + 1, i)
        const suffix = i < len ? ';' : ''
        out += `${rawProp}:${rewriteAnimationValue(valueSlice, keyframeMap)}${suffix}`
        i = end
        continue
      }
    }
    out += body.slice(start, end)
    i = end
  }

  return out
}

function scopeBlock(
  css: string,
  scopeAttr: string,
  keyframeMap: ReadonlyMap<string, string>,
): string {
  let out = ''
  let i = 0
  const len = css.length

  while (i < len) {
    if (/\s/.test(css[i]!)) {
      out += css[i]!
      i++
      continue
    }
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
      if (KEYFRAMES_AT_RULES.has(atName)) {
        const parsed = parseKeyframeName(trimmedPrelude)
        const scopedName = parsed !== null ? keyframeMap.get(parsed.unquotedName) : undefined
        if (parsed !== null && scopedName !== undefined) {
          const replacement = parsed.quote !== null ? `${parsed.quote}${scopedName}${parsed.quote}` : scopedName
          out += `${parsed.atRule} ${replacement} {${body}}`
        } else {
          out += `${prelude}{${body}}`
        }
      } else if (PASS_THROUGH_AT_RULES.has(atName)) {
        out += `${prelude}{${body}}`
      } else if (RECURSIVE_AT_RULES.has(atName)) {
        out += `${prelude}{${scopeBlock(body, scopeAttr, keyframeMap)}}`
      } else {
        out += `${prelude}{${body}}`
      }
    } else {
      const scopedPrelude = scopeSelectorList(prelude, scopeAttr)
      const rewrittenBody = rewriteAnimationDeclarations(body, keyframeMap)
      out += `${scopedPrelude} {${rewrittenBody}}`
    }

    i = closeIndex + 1
  }

  return out
}

/**
 * Splits any leading `@charset` / `@import` statements (which per CSS spec
 * must appear outside `@layer`) from the remainder of the stylesheet.
 */
function splitLeadingPreludeStatements(css: string): { leading: string; rest: string } {
  let i = 0
  const len = css.length
  let splitIndex = 0

  while (i < len) {
    while (i < len) {
      if (/\s/.test(css[i]!)) {
        i++
        continue
      }
      if (css[i] === '/' && css[i + 1] === '*') {
        const end = css.indexOf('*/', i + 2)
        if (end === -1) return { leading: css.slice(0, splitIndex), rest: css.slice(splitIndex) }
        i = end + 2
        continue
      }
      break
    }
    if (i >= len || css[i] !== '@') break
    const head = css.slice(i, i + 16).toLowerCase()
    if (!head.startsWith('@charset') && !head.startsWith('@import')) break

    let quote: string | null = null
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
      if (ch === '"' || ch === "'") {
        quote = ch
        i++
        continue
      }
      if (ch === ';') {
        i++
        splitIndex = i
        break
      }
      if (ch === '{') {
        return { leading: css.slice(0, splitIndex), rest: css.slice(splitIndex) }
      }
      i++
    }
  }

  return { leading: css.slice(0, splitIndex), rest: css.slice(splitIndex) }
}

/** Checks whether the non-whitespace/non-comment content is already a single `@layer plugin-ui { ... }` wrapper. */
function isWrappedInPluginLayer(css: string): boolean {
  let i = 0
  const len = css.length
  while (i < len) {
    if (/\s/.test(css[i]!)) {
      i++
      continue
    }
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      if (end === -1) return false
      i = end + 2
      continue
    }
    break
  }
  const rest = css.slice(i)
  const match = rest.match(/^@layer\s+plugin-ui\s*\{/i)
  if (match === null) return false
  const openBrace = i + match[0].length - 1
  const closeBrace = findMatchingBrace(css, openBrace)
  const trailing = css.slice(closeBrace + 1).replace(/\/\*[\s\S]*?\*\//g, '').trim()
  return trailing === ''
}

/**
 * Scope a plugin's stylesheet under `@layer plugin-ui` and `:where([data-plugin-id="<pluginId>"])`,
 * while scoping plugin `@keyframes` names and matching `animation` declarations.
 * Pure, idempotent, zero-specificity-overhead, and safe for `@media`,
 * `@supports`, `@container`, `@keyframes`, `@font-face`, and portalled roots.
 */
export function scopePluginCss(css: string, pluginId: string): string {
  if (css.trim() === '' || pluginId.trim() === '') return css
  const scopeAttr = `:where([data-plugin-id="${escapeCssAttrValue(pluginId)}"])`
  const kfPrefix = buildKeyframePrefix(pluginId)
  const keyframeMap = new Map<string, string>()
  collectKeyframes(css, kfPrefix, keyframeMap)

  const { leading, rest } = splitLeadingPreludeStatements(css)
  const scopedRest = scopeBlock(rest, scopeAttr, keyframeMap)
  if (scopedRest.trim() === '') {
    return `${leading}${scopedRest}`
  }
  if (isWrappedInPluginLayer(scopedRest)) {
    return `${leading}${scopedRest}`
  }
  return `${leading}@layer ${PLUGIN_LAYER_NAME} {\n${scopedRest}\n}`
}
