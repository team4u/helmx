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

function isCssWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f'
}

/** Advances from an opening quote (`"` or `'`) to the index immediately after its closing quote. */
function advancePastQuotedString(text: string, quoteStart: number): number {
  const quote = text.charAt(quoteStart)
  let i = quoteStart + 1
  const len = text.length
  while (i < len) {
    const ch = text.charAt(i)
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) return i + 1
    i++
  }
  return len
}

/** If a CSS comment starts at `start`, returns the index immediately after `* /`; otherwise `start`. */
function advancePastComment(text: string, start: number): number {
  if (text.charAt(start) !== '/' || text.charAt(start + 1) !== '*') return start
  const end = text.indexOf('*/', start + 2)
  return end === -1 ? text.length : end + 2
}

/** Advances `start` past CSS whitespace and comments. */
function skipWhitespaceAndComments(text: string, start: number): number {
  let i = start
  const len = text.length
  while (i < len) {
    if (isCssWhitespace(text.charAt(i))) {
      i++
      continue
    }
    const afterComment = advancePastComment(text, i)
    if (afterComment !== i) {
      i = afterComment
      continue
    }
    break
  }
  return i
}

/**
 * Strips `/* ... * /` comments only outside quoted strings so patterns like
 * `[data-x="/*keep* /"]` or `content: "/*keep* /"` are preserved verbatim.
 */
function stripCssComments(text: string): string {
  if (!text.includes('/*')) return text
  let out = ''
  let i = 0
  const len = text.length
  while (i < len) {
    const ch = text.charAt(i)
    if (ch === '"' || ch === "'") {
      const next = advancePastQuotedString(text, i)
      out += text.slice(i, next)
      i = next
      continue
    }
    const afterComment = advancePastComment(text, i)
    if (afterComment !== i) {
      i = afterComment
      continue
    }
    out += ch
    i++
  }
  return out
}

/**
 * Scans forward from `start` to the first top-level occurrence of any character in `stopChars`,
 * skipping quoted strings and comments (and optionally nested `{ ... }` blocks).
 */
function scanUntilDelimiter(
  text: string,
  start: number,
  stopChars: string,
  trackBraces = false,
): { index: number; delimiter: string } {
  let i = start
  let braceDepth = 0
  const len = text.length

  while (i < len) {
    const ch = text.charAt(i)
    if (ch === '"' || ch === "'") {
      i = advancePastQuotedString(text, i)
      continue
    }
    const afterComment = advancePastComment(text, i)
    if (afterComment !== i) {
      i = afterComment
      continue
    }
    if (trackBraces) {
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
    }
    if (braceDepth === 0 && stopChars.includes(ch)) {
      return { index: i, delimiter: ch }
    }
    i++
  }

  return { index: len, delimiter: '' }
}

/** Finds the matching `}` for the `{` at `openIndex`, respecting strings and comments. */
function findMatchingBrace(css: string, openIndex: number): number {
  let depth = 0
  let i = openIndex
  const len = css.length
  while (i < len) {
    const ch = css.charAt(i)
    if (ch === '"' || ch === "'") {
      i = advancePastQuotedString(css, i)
      continue
    }
    const afterComment = advancePastComment(css, i)
    if (afterComment !== i) {
      i = afterComment
      continue
    }
    if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return len - 1
}

function escapeCssAttrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function buildKeyframePrefix(pluginId: string): string {
  const slug = pluginId.replace(/[^a-zA-Z0-9-]/g, (ch) => {
    const cp = ch.codePointAt(0)
    return cp !== undefined ? `_${cp.toString(16)}_` : '_'
  })
  return `helmx-kf-${slug}-`
}

/** Splits a selector list by top-level commas, respecting quotes, parens, brackets, and comments. */
function splitSelectorList(selectorText: string): string[] {
  const parts: string[] = []
  let start = 0
  let parenDepth = 0
  let bracketDepth = 0
  let i = 0
  const len = selectorText.length

  while (i < len) {
    const ch = selectorText.charAt(i)
    if (ch === '"' || ch === "'") {
      i = advancePastQuotedString(selectorText, i)
      continue
    }
    const afterComment = advancePastComment(selectorText, i)
    if (afterComment !== i) {
      i = afterComment
      continue
    }
    if (ch === '(') {
      parenDepth++
    } else if (ch === ')') {
      if (parenDepth > 0) parenDepth--
    } else if (ch === '[') {
      bracketDepth++
    } else if (ch === ']') {
      if (bracketDepth > 0) bracketDepth--
    } else if (ch === ',' && parenDepth === 0 && bracketDepth === 0) {
      parts.push(selectorText.slice(start, i))
      start = i + 1
    }
    i++
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
  if (leadingTag !== null && leadingTag[1] !== undefined) {
    const tag = leadingTag[1]
    const rest = leadingTag[2] ?? ''
    return `${scopeAttr} ${trimmed}, ${tag}${scopeAttr}${rest}`
  }

  // Class / id / attribute / pseudo selector (e.g. `.drawer`, `.card:hover`, `[data-x]`):
  // match both descendants inside PluginScope and self-stamped portal roots (DialogContent / Screen).
  return `${scopeAttr} ${trimmed}, ${scopeAttr}${trimmed}`
}

function scopeSelectorList(selectorText: string, scopeAttr: string): string {
  const withoutComments = stripCssComments(selectorText).trim()
  if (withoutComments === '') return selectorText
  const scoped = splitSelectorList(withoutComments)
    .map((part) => scopeSingleSelector(part, scopeAttr))
    .filter((part) => part.length > 0)
  return scoped.join(', ')
}

function parseKeyframeName(
  trimmedPrelude: string,
): { atRule: string; rawName: string; unquotedName: string; quote: string | null } | null {
  const match = trimmedPrelude.match(
    /^(@(?:-webkit-|-moz-)?keyframes)\s+(?:"([^"]+)"|'([^']+)'|([a-zA-Z_-][a-zA-Z0-9_-]*))$/i,
  )
  if (match === null) return null
  const atRule = match[1]
  if (atRule === undefined) return null
  if (match[2] !== undefined) {
    return { atRule, rawName: `"${match[2]}"`, unquotedName: match[2], quote: '"' }
  }
  if (match[3] !== undefined) {
    return { atRule, rawName: `'${match[3]}'`, unquotedName: match[3], quote: "'" }
  }
  const ident = match[4]
  if (ident === undefined) return null
  return { atRule, rawName: ident, unquotedName: ident, quote: null }
}

function collectKeyframes(css: string, kfPrefix: string, keyframeMap: Map<string, string>): void {
  let i = 0
  const len = css.length

  while (i < len) {
    i = skipWhitespaceAndComments(css, i)
    if (i >= len) break

    const preludeStart = i
    const { index: delimIdx, delimiter } = scanUntilDelimiter(css, preludeStart, '{;')
    if (delimiter === ';') {
      i = delimIdx + 1
      continue
    }
    if (delimiter !== '{') break

    const closeIndex = findMatchingBrace(css, delimIdx)
    const body = css.slice(delimIdx + 1, closeIndex)
    const trimmedPrelude = stripCssComments(css.slice(preludeStart, delimIdx)).trim()

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
    const ch = value.charAt(i)
    const afterComment = advancePastComment(value, i)
    if (afterComment !== i) {
      out += value.slice(i, afterComment)
      i = afterComment
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
      const next = advancePastQuotedString(value, i)
      const raw = value.slice(i, next)
      const inner = next > i + 1 && value.charAt(next - 1) === ch ? value.slice(i + 1, next - 1) : ''
      const renamed = keyframeMap.get(inner)
      if (parenDepth === 0 && renamed !== undefined) {
        out += `${ch}${renamed}${ch}`
      } else {
        out += raw
      }
      i = next
      continue
    }
    if (parenDepth === 0 && /[a-zA-Z_-]/.test(ch)) {
      const prev = i > 0 ? value.charAt(i - 1) : ''
      let j = i + 1
      while (j < len && /[a-zA-Z0-9_-]/.test(value.charAt(j))) j++
      const ident = value.slice(i, j)
      const next = j < len ? value.charAt(j) : ''
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

/** Rewrites `animation` / `animation-name` declarations inside a style rule body, including nested rules. */
function rewriteStyleRuleBody(body: string, keyframeMap: ReadonlyMap<string, string>): string {
  if (keyframeMap.size === 0 || !/animation/i.test(body)) return body
  let out = ''
  let i = 0
  const len = body.length

  while (i < len) {
    const wsStart = i
    i = skipWhitespaceAndComments(body, i)
    out += body.slice(wsStart, i)
    if (i >= len) break

    const stmtStart = i
    const { index: delimIdx, delimiter } = scanUntilDelimiter(body, stmtStart, '{;')

    if (delimiter === '{') {
      const prelude = body.slice(stmtStart, delimIdx)
      const closeIndex = findMatchingBrace(body, delimIdx)
      const nestedBody = body.slice(delimIdx + 1, closeIndex)
      if (prelude.trimStart().startsWith('--')) {
        out += body.slice(stmtStart, closeIndex + 1)
      } else {
        out += `${prelude}{${rewriteStyleRuleBody(nestedBody, keyframeMap)}}`
      }
      i = closeIndex + 1
      continue
    }

    const stmtEnd = delimiter === ';' ? delimIdx + 1 : len
    const declaration = body.slice(stmtStart, delimIdx)
    const { index: colonOffset, delimiter: colonDelim } = scanUntilDelimiter(declaration, 0, ':', true)
    if (colonDelim === ':') {
      const rawProp = declaration.slice(0, colonOffset)
      const propName = stripCssComments(rawProp).trim().toLowerCase()
      if (ANIMATION_PROPERTIES.has(propName)) {
        const valueSlice = declaration.slice(colonOffset + 1)
        const suffix = delimiter === ';' ? ';' : ''
        out += `${rawProp}:${rewriteAnimationValue(valueSlice, keyframeMap)}${suffix}`
        i = stmtEnd
        continue
      }
    }

    out += body.slice(stmtStart, stmtEnd)
    i = stmtEnd
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
    const wsStart = i
    i = skipWhitespaceAndComments(css, i)
    out += css.slice(wsStart, i)
    if (i >= len) break

    const preludeStart = i
    const { index: delimIdx, delimiter } = scanUntilDelimiter(css, preludeStart, '{;')
    const prelude = css.slice(preludeStart, delimIdx)

    if (delimiter === ';') {
      out += `${prelude};`
      i = delimIdx + 1
      continue
    }
    if (delimiter !== '{') {
      out += prelude
      break
    }

    const closeIndex = findMatchingBrace(css, delimIdx)
    const body = css.slice(delimIdx + 1, closeIndex)
    const trimmedPrelude = stripCssComments(prelude).trim()

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
      const rewrittenBody = rewriteStyleRuleBody(body, keyframeMap)
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
    i = skipWhitespaceAndComments(css, i)
    if (i >= len || css.charAt(i) !== '@') break
    const head = css.slice(i, i + 16).toLowerCase()
    if (!head.startsWith('@charset') && !head.startsWith('@import')) break

    const { index: delimIdx, delimiter } = scanUntilDelimiter(css, i, '{;')
    if (delimiter === ';') {
      i = delimIdx + 1
      splitIndex = i
      continue
    }
    return { leading: css.slice(0, splitIndex), rest: css.slice(splitIndex) }
  }

  return { leading: css.slice(0, splitIndex), rest: css.slice(splitIndex) }
}

/** Checks whether the non-whitespace/non-comment content is already a single `@layer plugin-ui { ... }` wrapper. */
function isWrappedInPluginLayer(css: string): boolean {
  const i = skipWhitespaceAndComments(css, 0)
  const rest = css.slice(i)
  const match = rest.match(/^@layer\s+plugin-ui\s*\{/i)
  if (match === null) return false
  const openBrace = i + match[0].length - 1
  const closeBrace = findMatchingBrace(css, openBrace)
  const trailing = stripCssComments(css.slice(closeBrace + 1)).trim()
  return trailing === ''
}

/**
 * Scope a plugin's stylesheet under `@layer plugin-ui` and `:where([data-plugin-id="<pluginId>"])`,
 * while scoping plugin `@keyframes` names and matching `animation` declarations.
 * Pure, idempotent, zero-specificity-overhead, and safe for `@media`,
 * `@supports`, `@container`, `@keyframes`, `@font-face`, nested CSS rules, and portalled roots.
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
