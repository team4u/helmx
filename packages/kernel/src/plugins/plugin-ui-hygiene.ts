/**
 * Zero-dependency static UI and CSS hygiene scanner for external plugin `clientRoot`
 * validation inside `doctorPluginDir`.
 *
 * Mirrors the exact 5 rules enforced in-repo by `scripts/lib/ui-hygiene.mjs` and
 * `scripts/lib/css-hygiene.mjs` without depending on `typescript` (which is a dev-only
 * dependency and absent from production `@helmx/kernel` / `@helmx/hub` bundles):
 *   1. `no-native-select`: native `<select>` forbidden;
 *   2. `no-search-input`: `<input type="search">` forbidden;
 *   3. `no-ui-emoji`: UI Emoji in JSX text or string/template literals (excluding comments & imports) forbidden;
 *   4. `no-raw-control-class`: raw `.btn` / `.btn-*` / `.input` / `.input-sm` and retired legacy container/modal/tab/kbd
 *      class tokens (`section-flat`, `form-grid`, `kv-list`, `tabs-bar`, `tab-btn`, `modal-header`, `modal-footer`,
 *      `dropdown-panel`, `kbd-hint`, `card`) forbidden on intrinsic lowercase JSX elements (`<button>`, `<input>`, `<a>`,
 *      `<div>`, `<span>`, `<kbd>`, ...);
 *   5. `hover-media-gate`: `:hover` CSS rule outside `@media (hover: hover)` or `@media (hover: none)` forbidden.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export type PluginUiHygieneRule =
  | 'no-native-select'
  | 'no-search-input'
  | 'no-ui-emoji'
  | 'no-raw-control-class'
  | 'hover-media-gate';

export interface PluginUiHygieneViolation {
  file: string;
  line: number;
  rule: PluginUiHygieneRule;
  message: string;
}

const UI_EMOJI_PATTERN =
  /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]\uFE0F?\u20E3|[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2764}])/u;

const RAW_CONTROL_CLASS_TOKEN_RE =
  /^(?:btn(?:-[a-z0-9_-]+)?|input(?:-sm)?|section-flat|form-grid|kv-list|tabs-bar|tab-btn|modal-header|modal-footer|dropdown-panel|kbd-hint|card)$/;
const TEMPLATE_EXPR_PLACEHOLDER = '___expr___';

// ---------------------------------------------------------------------------
// CSS :hover media gate (mirrors scripts/lib/css-hygiene.mjs)
// ---------------------------------------------------------------------------

const HOVER_FEATURE_RE = /\(\s*hover\s*:\s*(hover|none)\s*\)/g;
const MEDIA_NAME_RE = /^@([a-zA-Z-]+)/;

function splitMediaBranches(params: string): string[] {
  const branches: string[] = [];
  let current = '';
  let depth = 0;
  for (const ch of params) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      branches.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  branches.push(current);
  return branches.map((b) => b.trim()).filter((b) => b !== '');
}

function hoverMediaGate(params: string): 'hover' | 'none' | null {
  const branches = splitMediaBranches(params);
  if (branches.length === 0) return null;
  const kinds = branches.map((branch) => {
    if (/^not\b/i.test(branch)) return null;
    const features = Array.from(branch.matchAll(HOVER_FEATURE_RE), (m) => m[1]);
    if (features.includes('hover')) return 'hover';
    if (features.includes('none')) return 'none';
    return null;
  });
  if (kinds.every((kind) => kind === 'hover')) return 'hover';
  if (kinds.every((kind) => kind === 'none')) return 'none';
  return null;
}

function selectorHasHover(selector: string): boolean {
  let rest = selector;
  let prev: string;
  do {
    prev = rest;
    rest = rest.replace(/:not\([^()]*\)/g, '');
  } while (rest !== prev);
  return /:hover\b/.test(rest);
}

function blankCssCommentsAndStrings(css: string): string {
  return css.replace(
    /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g,
    (match) => match.replace(/[^\n]/g, ' '),
  );
}

export function scanPluginCssUiHygiene(filePath: string, css: string): PluginUiHygieneViolation[] {
  const text = blankCssCommentsAndStrings(css);
  const violations: PluginUiHygieneViolation[] = [];
  const stack: Array<{ hoverGate: null | 'hover' | 'none'; keyframes: boolean }> = [];
  let prelude = '';
  let preludeLine = 1;
  let line = 1;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\n') line += 1;
    if (ch === '{') {
      const head = prelude.trim();
      const frame: { hoverGate: null | 'hover' | 'none'; keyframes: boolean } = {
        hoverGate: null,
        keyframes: false,
      };
      if (head.startsWith('@')) {
        const name = MEDIA_NAME_RE.exec(head);
        const kind = name ? name[1]!.toLowerCase() : '';
        if (kind === 'media') {
          frame.hoverGate = hoverMediaGate(head.slice(name![0].length));
        } else if (kind.endsWith('keyframes')) {
          frame.keyframes = true;
        }
      } else if (head !== '' && selectorHasHover(head) && !stack.some((f) => f.hoverGate || f.keyframes)) {
        const selector = head.replace(/\s+/g, ' ').slice(0, 120);
        violations.push({
          file: filePath,
          line: preludeLine,
          rule: 'hover-media-gate',
          message: `":hover" rule must sit inside @media (hover: hover) or @media (hover: none): ${selector}`,
        });
      }
      stack.push(frame);
      prelude = '';
      continue;
    }
    if (ch === '}') {
      stack.pop();
      prelude = '';
      continue;
    }
    if (ch === ';') {
      prelude = '';
      continue;
    }
    if (prelude.trim() === '') preludeLine = line;
    prelude += ch;
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Zero-dependency TSX UI hygiene scanner (4 rules)
// ---------------------------------------------------------------------------

const REGEX_PREFIX_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'in',
  'of',
  'typeof',
  'void',
  'delete',
  'await',
  'yield',
  'else',
  'do',
  'new',
  'instanceof',
]);

const JSX_PREFIX_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'else',
  'yield',
  'await',
  'default',
  'export',
]);

const REGEX_PREFIX_PUNCT = new Set([
  '=',
  '(',
  '[',
  '{',
  ',',
  ';',
  ':',
  '!',
  '?',
  '&',
  '|',
  '^',
  '~',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '=>',
]);

const JSX_PREFIX_PUNCT = new Set([
  '=',
  '(',
  '[',
  '{',
  ',',
  ';',
  ':',
  '!',
  '?',
  '&',
  '|',
  '=>',
  '...',
  '+',
]);

const CLASS_HELPER_NAMES = new Set(['clsx', 'cx', 'cn', 'joinClass', 'joinClasses', 'classNames']);

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

function isTagNamePart(ch: string): boolean {
  return isIdentPart(ch) || ch === '-' || ch === '.' || ch === ':';
}

function findRawControlTokens(classText: string): string[] {
  const matched: string[] = [];
  for (const rawToken of classText.split(/\s+/)) {
    if (!rawToken) continue;
    if (RAW_CONTROL_CLASS_TOKEN_RE.test(rawToken)) {
      matched.push(rawToken.replaceAll(TEMPLATE_EXPR_PLACEHOLDER, '${...}'));
    }
  }
  return matched;
}

/**
 * Extracts statically reachable string values from an attribute JS expression slice
 * (`{ ... }` body), skipping ternary conditions and comparison operands.
 */
function extractExprStringValues(exprSource: string, baseLine: number): Array<{ text: string; line: number }> {
  interface MiniToken {
    kind: 'string' | 'template' | 'ident' | 'punct' | 'other';
    value: string;
    line: number;
    templateHead?: string;
    templateSpans?: Array<{ expr: string; line: number; literal: string }>;
  }

  const tokens: MiniToken[] = [];
  let i = 0;
  let line = baseLine;
  const len = exprSource.length;

  while (i < len) {
    const ch = exprSource[i]!;
    if (ch === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (ch <= ' ') {
      i += 1;
      continue;
    }
    if (ch === '/' && exprSource[i + 1] === '/') {
      i += 2;
      while (i < len && exprSource[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && exprSource[i + 1] === '*') {
      i += 2;
      while (i < len && !(exprSource[i] === '*' && exprSource[i + 1] === '/')) {
        if (exprSource[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      const startLine = line;
      const quote = ch;
      i += 1;
      let val = '';
      while (i < len && exprSource[i] !== quote) {
        if (exprSource[i] === '\\' && i + 1 < len) {
          const next = exprSource[i + 1]!;
          if (next === '\n') line += 1;
          val += next;
          i += 2;
          continue;
        }
        if (exprSource[i] === '\n') line += 1;
        val += exprSource[i]!;
        i += 1;
      }
      i += 1;
      tokens.push({ kind: 'string', value: val, line: startLine });
      continue;
    }
    if (ch === '`') {
      const startLine = line;
      i += 1;
      let chunk = '';
      let head: string | null = null;
      const spans: Array<{ expr: string; line: number; literal: string }> = [];
      let pendingExpr: { expr: string; line: number } | null = null;
      while (i < len && exprSource[i] !== '`') {
        if (exprSource[i] === '\\' && i + 1 < len) {
          const next = exprSource[i + 1]!;
          if (next === '\n') line += 1;
          chunk += next;
          i += 2;
          continue;
        }
        if (exprSource[i] === '$' && exprSource[i + 1] === '{') {
          if (head === null) head = chunk;
          else if (pendingExpr !== null) spans.push({ ...pendingExpr, literal: chunk });
          chunk = '';
          i += 2;
          const exprStart = i;
          const exprStartLine = line;
          let depth = 1;
          while (i < len && depth > 0) {
            const c = exprSource[i]!;
            if (c === '\n') line += 1;
            else if (c === '\'' || c === '"' || c === '`') {
              const q = c;
              i += 1;
              while (i < len && exprSource[i] !== q) {
                if (exprSource[i] === '\\') i += 1;
                else if (exprSource[i] === '\n') line += 1;
                i += 1;
              }
            } else if (c === '{') depth += 1;
            else if (c === '}') depth -= 1;
            i += 1;
          }
          pendingExpr = { expr: exprSource.slice(exprStart, Math.max(exprStart, i - 1)), line: exprStartLine };
          continue;
        }
        if (exprSource[i] === '\n') line += 1;
        chunk += exprSource[i]!;
        i += 1;
      }
      if (head === null) head = chunk;
      else if (pendingExpr !== null) spans.push({ ...pendingExpr, literal: chunk });
      i += 1;
      tokens.push({ kind: 'template', value: head, line: startLine, templateHead: head, templateSpans: spans });
      continue;
    }
    if (isIdentStart(ch)) {
      const start = i;
      const startLine = line;
      i += 1;
      while (i < len && isIdentPart(exprSource[i]!)) i += 1;
      tokens.push({ kind: 'ident', value: exprSource.slice(start, i), line: startLine });
      continue;
    }
    // Multi-char operators
    const three = exprSource.slice(i, i + 3);
    if (three === '===' || three === '!==' || three === '...') {
      tokens.push({ kind: 'punct', value: three, line });
      i += 3;
      continue;
    }
    const two = exprSource.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '??' || two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '=>') {
      tokens.push({ kind: 'punct', value: two, line });
      i += 2;
      continue;
    }
    tokens.push({ kind: 'punct', value: ch, line });
    i += 1;
  }

  const out: Array<{ text: string; line: number }> = [];

  const collectRange = (start: number, end: number): void => {
    // Trim outer parens and TS assertions (`as ...`, `satisfies ...`, `!`)
    let s = start;
    let e = end;
    while (s < e && tokens[s]!.value === '(' && tokens[e - 1]!.value === ')') {
      let depth = 0;
      let wrapsAll = true;
      for (let k = s; k < e - 1; k += 1) {
        const v = tokens[k]!.value;
        if (v === '(' || v === '[' || v === '{') depth += 1;
        else if (v === ')' || v === ']' || v === '}') depth -= 1;
        if (depth === 0) {
          wrapsAll = false;
          break;
        }
      }
      if (!wrapsAll) break;
      s += 1;
      e -= 1;
    }
    if (s >= e) return;

    // Strip trailing `as ...` / `satisfies ...` at depth 0
    {
      let depth = 0;
      for (let k = s; k < e; k += 1) {
        const t = tokens[k]!;
        if (t.value === '(' || t.value === '[' || t.value === '{') depth += 1;
        else if (t.value === ')' || t.value === ']' || t.value === '}') depth -= 1;
        else if (depth === 0 && t.kind === 'ident' && (t.value === 'as' || t.value === 'satisfies')) {
          e = k;
          break;
        }
      }
    }
    while (s < e && tokens[e - 1]!.value === '!') e -= 1;
    if (s >= e) return;

    // 1. Single string or template literal
    if (e - s === 1) {
      const t = tokens[s]!;
      if (t.kind === 'string') {
        out.push({ text: t.value, line: t.line });
      } else if (t.kind === 'template') {
        const headText = t.templateHead ?? t.value;
        const spans = t.templateSpans ?? [];
        if (spans.length === 0) {
          out.push({ text: headText, line: t.line });
        } else {
          let synthetic = headText;
          let prevEndsAttached = headText.length > 0 && !/\s$/.test(headText);
          for (const span of spans) {
            const spanValues = extractExprStringValues(span.expr, span.line);
            const literalText = span.literal;
            const nextStartsAttached = literalText.length > 0 && !/^\s/.test(literalText);
            const startsWithBoundary =
              spanValues.length > 0 && spanValues.every((v) => v.text === '' || /^\s/.test(v.text));
            const endsWithBoundary =
              spanValues.length > 0 && spanValues.every((v) => v.text === '' || /\s$/.test(v.text));

            for (const v of spanValues) {
              let text = v.text;
              if (prevEndsAttached && text !== '' && !/^\s/.test(text)) {
                text = TEMPLATE_EXPR_PLACEHOLDER + text;
              }
              if (nextStartsAttached && text !== '' && !/\s$/.test(text)) {
                text = text + TEMPLATE_EXPR_PLACEHOLDER;
              }
              out.push({ text, line: v.line });
            }

            synthetic +=
              (startsWithBoundary ? ' ' : '') +
              TEMPLATE_EXPR_PLACEHOLDER +
              (endsWithBoundary ? ' ' : '') +
              literalText;

            prevEndsAttached = literalText.length > 0 ? !/\s$/.test(literalText) : !endsWithBoundary;
          }
          out.push({ text: synthetic, line: t.line });
        }
      }
      return;
    }

    // 2. Top-level ternary `cond ? a : b` -> skip cond, recurse on `a` and `b`
    {
      let depth = 0;
      let qIdx = -1;
      let ternaryNest = 0;
      let colonIdx = -1;
      for (let k = s; k < e; k += 1) {
        const v = tokens[k]!.value;
        if (v === '(' || v === '[' || v === '{') depth += 1;
        else if (v === ')' || v === ']' || v === '}') depth -= 1;
        else if (depth === 0) {
          if (v === '?') {
            if (qIdx === -1) qIdx = k;
            else ternaryNest += 1;
          } else if (v === ':' && qIdx !== -1) {
            if (ternaryNest === 0) {
              colonIdx = k;
              break;
            }
            ternaryNest -= 1;
          }
        }
      }
      if (qIdx !== -1 && colonIdx !== -1) {
        collectRange(qIdx + 1, colonIdx);
        collectRange(colonIdx + 1, e);
        return;
      }
    }

    // 3. Top-level logical / concat operators (`||`, `??`, `&&`, `+`) and comparisons (stop)
    {
      let depth = 0;
      let splitIdx = -1;
      let splitOp = '';
      for (let k = s; k < e; k += 1) {
        const v = tokens[k]!.value;
        if (v === '(' || v === '[' || v === '{') depth += 1;
        else if (v === ')' || v === ']' || v === '}') depth -= 1;
        else if (depth === 0) {
          if (v === '||' || v === '??') {
            splitIdx = k;
            splitOp = v;
            break;
          }
          if (v === '&&' && splitIdx === -1) {
            splitIdx = k;
            splitOp = v;
          } else if (v === '+' && splitIdx === -1) {
            splitIdx = k;
            splitOp = v;
          } else if (v === '===' || v === '!==' || v === '==' || v === '!=' || v === '<' || v === '>' || v === '<=' || v === '>=') {
            if (splitIdx === -1) {
              splitIdx = k;
              splitOp = 'cmp';
            }
          }
        }
      }
      if (splitIdx !== -1) {
        if (splitOp === 'cmp') return;
        if (splitOp === '&&') {
          collectRange(splitIdx + 1, e);
        } else {
          collectRange(s, splitIdx);
          collectRange(splitIdx + 1, e);
        }
        return;
      }
    }

    // 4. Array literal `[a, b, ...]`
    if (tokens[s]!.value === '[' && tokens[e - 1]!.value === ']') {
      let depth = 0;
      let elemStart = s + 1;
      for (let k = s + 1; k < e - 1; k += 1) {
        const v = tokens[k]!.value;
        if (v === '(' || v === '[' || v === '{') depth += 1;
        else if (v === ')' || v === ']' || v === '}') depth -= 1;
        else if (depth === 0 && v === ',') {
          collectRange(elemStart, k);
          elemStart = k + 1;
        }
      }
      collectRange(elemStart, e - 1);
      return;
    }

    // 5. Call expression: helper(`...`) or receiver.filter/join/trim(...)
    if (tokens[e - 1]!.value === ')') {
      let depth = 0;
      let openParen = -1;
      for (let k = e - 1; k >= s; k -= 1) {
        const v = tokens[k]!.value;
        if (v === ')' || v === ']' || v === '}') depth += 1;
        else if (v === '(' || v === '[' || v === '{') {
          depth -= 1;
          if (depth === 0) {
            openParen = k;
            break;
          }
        }
      }
      if (openParen > s) {
        if (openParen === s + 1 && tokens[s]!.kind === 'ident' && CLASS_HELPER_NAMES.has(tokens[s]!.value)) {
          let argDepth = 0;
          let argStart = openParen + 1;
          for (let k = openParen + 1; k < e - 1; k += 1) {
            const v = tokens[k]!.value;
            if (v === '(' || v === '[' || v === '{') argDepth += 1;
            else if (v === ')' || v === ']' || v === '}') argDepth -= 1;
            else if (argDepth === 0 && v === ',') {
              collectRange(argStart, k);
              argStart = k + 1;
            }
          }
          collectRange(argStart, e - 1);
          return;
        }
        if (
          openParen >= s + 2 &&
          tokens[openParen - 2]!.value === '.' &&
          tokens[openParen - 1]!.kind === 'ident' &&
          (tokens[openParen - 1]!.value === 'join' ||
            tokens[openParen - 1]!.value === 'filter' ||
            tokens[openParen - 1]!.value === 'trim')
        ) {
          collectRange(s, openParen - 2);
        }
      }
    }
  };

  collectRange(0, tokens.length);
  return out;
}

export function scanPluginTsxUiHygiene(filePath: string, source: string): PluginUiHygieneViolation[] {
  const violations: PluginUiHygieneViolation[] = [];
  const len = source.length;
  let i = 0;
  let line = 1;

  const checkEmoji = (text: string, startLine: number): void => {
    const match = UI_EMOJI_PATTERN.exec(text);
    if (!match) return;
    // Compute exact line inside multi-line text/string
    const prefix = text.slice(0, match.index);
    let offsetLines = 0;
    for (let k = 0; k < prefix.length; k += 1) {
      if (prefix[k] === '\n') offsetLines += 1;
    }
    violations.push({
      file: filePath,
      line: startLine + offsetLines,
      rule: 'no-ui-emoji',
      message: `UI Emoji "${match[0]}" is forbidden (use plain text and <HelmxIcon> vector icons)`,
    });
  };

  const skipWhitespaceAndComments = (): void => {
    while (i < len) {
      const ch = source[i]!;
      if (ch === '\n') {
        line += 1;
        i += 1;
        continue;
      }
      if (ch <= ' ') {
        i += 1;
        continue;
      }
      if (ch === '/' && source[i + 1] === '/') {
        i += 2;
        while (i < len && source[i] !== '\n') i += 1;
        continue;
      }
      if (ch === '/' && source[i + 1] === '*') {
        i += 2;
        while (i < len && !(source[i] === '*' && source[i + 1] === '/')) {
          if (source[i] === '\n') line += 1;
          i += 1;
        }
        i += 2;
        continue;
      }
      break;
    }
  };

  const readQuotedString = (checkForEmoji: boolean): { text: string; startLine: number } => {
    const quote = source[i]!;
    const startLine = line;
    i += 1;
    let text = '';
    while (i < len && source[i] !== quote) {
      if (source[i] === '\\' && i + 1 < len) {
        const next = source[i + 1]!;
        if (next === '\n') line += 1;
        text += next;
        i += 2;
        continue;
      }
      if (source[i] === '\n') line += 1;
      text += source[i]!;
      i += 1;
    }
    if (i < len) i += 1;
    if (checkForEmoji) checkEmoji(text, startLine);
    return { text, startLine };
  };

  const readTemplateLiteral = (): void => {
    i += 1; // skip opening `
    let chunk = '';
    let chunkStartLine = line;
    while (i < len) {
      const ch = source[i]!;
      if (ch === '`') {
        checkEmoji(chunk, chunkStartLine);
        i += 1;
        return;
      }
      if (ch === '\\' && i + 1 < len) {
        const next = source[i + 1]!;
        if (next === '\n') line += 1;
        chunk += next;
        i += 2;
        continue;
      }
      if (ch === '$' && source[i + 1] === '{') {
        checkEmoji(chunk, chunkStartLine);
        i += 2;
        scanCode(true);
        chunk = '';
        chunkStartLine = line;
        continue;
      }
      if (ch === '\n') line += 1;
      chunk += ch;
      i += 1;
    }
    checkEmoji(chunk, chunkStartLine);
  };

  const skipRegexLiteral = (): void => {
    i += 1; // skip opening /
    let inClass = false;
    while (i < len) {
      const ch = source[i]!;
      if (ch === '\\' && i + 1 < len) {
        if (source[i + 1] === '\n') line += 1;
        i += 2;
        continue;
      }
      if (ch === '\n') {
        line += 1;
        i += 1;
        return;
      }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        i += 1;
        while (i < len && /[a-zA-Z]/.test(source[i]!)) i += 1;
        return;
      }
      i += 1;
    }
  };

  /** Look ahead past whitespace/comments from `pos` without mutating scanner state. */
  const peekAfterWs = (startPos: number): number => {
    let p = startPos;
    while (p < len) {
      const c = source[p]!;
      if (c <= ' ') {
        p += 1;
        continue;
      }
      if (c === '/' && source[p + 1] === '/') {
        p += 2;
        while (p < len && source[p] !== '\n') p += 1;
        continue;
      }
      if (c === '/' && source[p + 1] === '*') {
        p += 2;
        while (p < len && !(source[p] === '*' && source[p + 1] === '/')) p += 1;
        p += 2;
        continue;
      }
      break;
    }
    return p;
  };

  /** Check whether `<` at current `i` starts a JSX tag (or fragment) rather than `<` comparison or TS generic. */
  const canStartJsxAtCurrent = (prevToken: string, prevKind: 'none' | 'ident' | 'punct' | 'literal'): boolean => {
    const allowedByPrev =
      prevKind === 'none' ||
      (prevKind === 'punct' && JSX_PREFIX_PUNCT.has(prevToken)) ||
      (prevKind === 'ident' && JSX_PREFIX_KEYWORDS.has(prevToken));
    if (!allowedByPrev) return false;
    const next = source[i + 1];
    if (next === '>') return true; // JSX fragment <>
    if (next === undefined || !isIdentStart(next)) return false;

    // Read candidate tag name
    let p = i + 1;
    while (p < len && isTagNamePart(source[p]!)) p += 1;
    const tag = source.slice(i + 1, p);
    const afterPos = peekAfterWs(p);
    const afterChar = source[afterPos];

    // Generic arrow function `<T,>(...) =>` or `<T extends Foo>(...) =>` or `<T = Foo>(...) =>`
    if (afterChar === ',' || afterChar === '=') return false;
    if (source.slice(afterPos, afterPos + 7) === 'extends' && !isIdentPart(source[afterPos + 7] ?? '')) {
      return false;
    }
    // Lowercase intrinsic element or uppercase component followed by `>`, `/`, attribute name, or `{...}` spread
    if (afterChar === '>' || afterChar === '/' || afterChar === '{' || (afterChar !== undefined && isIdentStart(afterChar))) {
      // Distinguish `return <Foo>(x)` generic call vs JSX — in TSX angle-bracket casts are forbidden,
      // and a generic arrow requires `,` or `extends`, so any valid tag followed by `>` / `/` / attr / `{` is JSX.
      return tag.length > 0;
    }
    return false;
  };

  const scanJsxElement = (): void => {
    const tagStartLine = line;
    i += 1; // skip '<'

    // JSX Fragment <>...</>
    if (source[i] === '>') {
      i += 1;
      scanJsxChildren('');
      return;
    }

    const nameStart = i;
    while (i < len && isTagNamePart(source[i]!)) i += 1;
    const tagName = source.slice(nameStart, i);
    const isIntrinsic = /^[a-z][a-z0-9-]*$/.test(tagName);

    if (tagName === 'select') {
      violations.push({
        file: filePath,
        line: tagStartLine,
        rule: 'no-native-select',
        message: 'native <select> is forbidden (use @helmx/plugin-client <Select> or <MultiSelect>)',
      });
    }

    let searchTypeReported = false;
    let selfClosing = false;

    // Parse attributes until `>` or `/>`
    while (i < len) {
      skipWhitespaceAndComments();
      if (i >= len) break;
      const ch = source[i]!;
      if (ch === '>') {
        i += 1;
        break;
      }
      if (ch === '/' && source[i + 1] === '>') {
        selfClosing = true;
        i += 2;
        break;
      }
      if (ch === '{') {
        i += 1;
        scanCode(true);
        continue;
      }
      if (isIdentStart(ch)) {
        const attrLine = line;
        const attrStart = i;
        i += 1;
        while (i < len && (isIdentPart(source[i]!) || source[i] === '-' || source[i] === ':')) i += 1;
        const attrName = source.slice(attrStart, i);

        skipWhitespaceAndComments();
        if (source[i] !== '=') {
          continue;
        }
        i += 1; // skip '='
        skipWhitespaceAndComments();

        const valChar = source[i];
        if (valChar === '"' || valChar === '\'') {
          const { text, startLine } = readQuotedString(true);
          if (tagName === 'input' && attrName === 'type' && !searchTypeReported && text.trim().toLowerCase() === 'search') {
            searchTypeReported = true;
            violations.push({
              file: filePath,
              line: attrLine,
              rule: 'no-search-input',
              message: '<input type="search"> is forbidden (use @helmx/plugin-client <SearchBox> or <Input type="text">)',
            });
          }
          if (isIntrinsic && attrName === 'className') {
            const badTokens = findRawControlTokens(text);
            if (badTokens.length > 0) {
              violations.push({
                file: filePath,
                line: startLine,
                rule: 'no-raw-control-class',
                message: `raw/legacy UI class token(s) [${[...new Set(badTokens)].join(', ')}] on intrinsic <${tagName}> bypass @helmx/plugin-client primitives (use <Button>, <IconButton>, <Input>, <Card>, <Field>, <KvGrid>, <Tabs>, <ModalDialog>, <DropdownMenu>, or <Kbd>)`,
              });
            }
          }
        } else if (valChar === '{') {
          i += 1;
          const exprStart = i;
          const exprStartLine = line;
          scanCode(true);
          const exprEnd = Math.max(exprStart, i - 1);
          if ((tagName === 'input' && attrName === 'type' && !searchTypeReported) || (isIntrinsic && attrName === 'className')) {
            const exprSlice = source.slice(exprStart, exprEnd);
            const values = extractExprStringValues(exprSlice, exprStartLine);
            if (tagName === 'input' && attrName === 'type' && !searchTypeReported) {
              if (values.some((v) => v.text.trim().toLowerCase() === 'search')) {
                searchTypeReported = true;
                violations.push({
                  file: filePath,
                  line: attrLine,
                  rule: 'no-search-input',
                  message: '<input type="search"> is forbidden (use @helmx/plugin-client <SearchBox> or <Input type="text">)',
                });
              }
            }
            if (isIntrinsic && attrName === 'className') {
              const badTokens = new Set<string>();
              let firstLine = attrLine;
              for (const value of values) {
                const found = findRawControlTokens(value.text);
                if (found.length > 0) {
                  if (badTokens.size === 0 || value.line < firstLine) firstLine = value.line;
                  for (const token of found) badTokens.add(token);
                }
              }
              if (badTokens.size > 0) {
                violations.push({
                  file: filePath,
                  line: firstLine,
                  rule: 'no-raw-control-class',
                  message: `raw/legacy UI class token(s) [${[...badTokens].join(', ')}] on intrinsic <${tagName}> bypass @helmx/plugin-client primitives (use <Button>, <IconButton>, <Input>, <Card>, <Field>, <KvGrid>, <Tabs>, <ModalDialog>, <DropdownMenu>, or <Kbd>)`,
                });
              }
            }
          }
        }
        continue;
      }
      // Fallback: advance one char to guarantee forward progress on malformed input
      if (ch === '\n') line += 1;
      i += 1;
    }

    if (!selfClosing) {
      scanJsxChildren(tagName);
    }
  };

  const scanJsxChildren = (openTag: string): void => {
    let textBuf = '';
    let textStartLine = line;
    const flushText = (): void => {
      if (textBuf.length > 0) {
        checkEmoji(textBuf, textStartLine);
        textBuf = '';
      }
    };

    while (i < len) {
      const ch = source[i]!;
      if (ch === '{') {
        flushText();
        i += 1;
        scanCode(true);
        textStartLine = line;
        continue;
      }
      if (ch === '<') {
        if (source[i + 1] === '/') {
          flushText();
          i += 2;
          while (i < len && source[i] !== '>') {
            if (source[i] === '\n') line += 1;
            i += 1;
          }
          if (i < len) i += 1; // skip '>'
          void openTag;
          return;
        }
        if (source[i + 1] === '>' || (source[i + 1] !== undefined && isIdentStart(source[i + 1]!))) {
          flushText();
          scanJsxElement();
          textStartLine = line;
          continue;
        }
      }
      if (textBuf.length === 0) textStartLine = line;
      if (ch === '\n') line += 1;
      textBuf += ch;
      i += 1;
    }
    flushText();
  };

  const scanCode = (stopOnClosingBrace: boolean): void => {
    let braceDepth = 0;
    let prevToken = '';
    let prevKind: 'none' | 'ident' | 'punct' | 'literal' = 'none';
    let expectModuleSpecifier = false;

    while (i < len) {
      const ch = source[i]!;
      if (ch === '\n') {
        line += 1;
        i += 1;
        continue;
      }
      if (ch <= ' ') {
        i += 1;
        continue;
      }
      if (ch === '/' && source[i + 1] === '/') {
        i += 2;
        while (i < len && source[i] !== '\n') i += 1;
        continue;
      }
      if (ch === '/' && source[i + 1] === '*') {
        i += 2;
        while (i < len && !(source[i] === '*' && source[i + 1] === '/')) {
          if (source[i] === '\n') line += 1;
          i += 1;
        }
        i += 2;
        continue;
      }
      if (ch === '{') {
        braceDepth += 1;
        prevToken = '{';
        prevKind = 'punct';
        expectModuleSpecifier = false;
        i += 1;
        continue;
      }
      if (ch === '}') {
        if (braceDepth === 0 && stopOnClosingBrace) {
          i += 1;
          return;
        }
        if (braceDepth > 0) braceDepth -= 1;
        prevToken = '}';
        prevKind = 'punct';
        expectModuleSpecifier = false;
        i += 1;
        continue;
      }
      if (ch === '\'' || ch === '"') {
        readQuotedString(!expectModuleSpecifier);
        prevToken = 'str';
        prevKind = 'literal';
        expectModuleSpecifier = false;
        continue;
      }
      if (ch === '`') {
        readTemplateLiteral();
        prevToken = 'tpl';
        prevKind = 'literal';
        expectModuleSpecifier = false;
        continue;
      }
      if (ch === '/') {
        const allowRegex =
          prevKind === 'none' ||
          (prevKind === 'punct' && REGEX_PREFIX_PUNCT.has(prevToken)) ||
          (prevKind === 'ident' && REGEX_PREFIX_KEYWORDS.has(prevToken));
        if (allowRegex) {
          skipRegexLiteral();
          prevToken = 're';
          prevKind = 'literal';
          expectModuleSpecifier = false;
          continue;
        }
        prevToken = '/';
        prevKind = 'punct';
        expectModuleSpecifier = false;
        i += 1;
        continue;
      }
      if (ch === '<' && canStartJsxAtCurrent(prevToken, prevKind)) {
        scanJsxElement();
        prevToken = 'jsx';
        prevKind = 'literal';
        expectModuleSpecifier = false;
        continue;
      }
      if (isIdentStart(ch)) {
        const start = i;
        i += 1;
        while (i < len && isIdentPart(source[i]!)) i += 1;
        const word = source.slice(start, i);
        expectModuleSpecifier = word === 'from' || word === 'import';
        prevToken = word;
        prevKind = 'ident';
        continue;
      }
      if (ch >= '0' && ch <= '9') {
        i += 1;
        while (i < len && /[0-9a-zA-Z_.]/.test(source[i]!)) i += 1;
        prevToken = 'num';
        prevKind = 'literal';
        expectModuleSpecifier = false;
        continue;
      }
      if (ch === '=' && source[i + 1] === '>') {
        prevToken = '=>';
        prevKind = 'punct';
        expectModuleSpecifier = false;
        i += 2;
        continue;
      }
      if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
        prevToken = '...';
        prevKind = 'punct';
        expectModuleSpecifier = false;
        i += 3;
        continue;
      }
      prevToken = ch;
      prevKind = 'punct';
      expectModuleSpecifier = false;
      i += 1;
    }
  };

  scanCode(false);
  violations.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  return violations;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.helmx']);

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Recursively scans an external plugin's `clientRoot` for TSX UI hygiene and CSS `:hover` gate violations.
 * Skips symlinks and build/dependency folders (`node_modules`, `dist`, `.git`, `.helmx`).
 */
export function scanPluginClientDirUiHygiene(pluginDir: string, clientRoot: string): PluginUiHygieneViolation[] {
  if (!existsSync(clientRoot)) return [];
  try {
    if (!statSync(clientRoot).isDirectory()) return [];
  } catch {
    return [];
  }

  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile() && (entry.name.endsWith('.tsx') || entry.name.endsWith('.css'))) {
        files.push(join(dir, entry.name));
      }
    }
  };
  walk(clientRoot);
  files.sort((a, b) => toPosix(a).localeCompare(toPosix(b)));

  const violations: PluginUiHygieneViolation[] = [];
  for (const abs of files) {
    const rel = toPosix(relative(pluginDir, abs));
    const displayPath = rel !== '' && !rel.startsWith('..') ? rel : toPosix(relative(clientRoot, abs));
    const source = readFileSync(abs, 'utf8');
    if (abs.endsWith('.tsx')) {
      violations.push(...scanPluginTsxUiHygiene(displayPath, source));
    } else if (abs.endsWith('.css')) {
      violations.push(...scanPluginCssUiHygiene(displayPath, source));
    }
  }

  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
  return violations;
}
