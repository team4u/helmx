/**
 * Static UI TSX source hygiene (TypeScript Compiler API, zero extra lint dependencies).
 *
 * Enforces the Helmx UI HIG static invariants across business UI sources
 * (`packages/web/src/**\/*.tsx` and `packages/plugins/src/*\/client/**\/*.tsx`):
 *   no-native-select       native `<select>` is forbidden (use `@helmx/ui` `<Select>` / `<MultiSelect>`);
 *   no-search-input        `<input type="search">` is forbidden (use `<SearchBox>` or `<Input type="text">`);
 *   no-ui-emoji            UI Emoji in JSX text or string/template literals (excluding comments & imports) is forbidden;
 *   no-raw-control-class   raw `.btn` / `.btn-*` / `.input` / `.input-sm` and retired legacy container/modal/tab/kbd
 *                          class tokens (`section-flat`, `form-grid`, `kv-list`, `tabs-bar`, `tab-btn`, `modal-header`,
 *                          `modal-footer`, `dropdown-panel`, `kbd-hint`, `card`) bypassing SDK are forbidden strictly on
 *                          intrinsic lowercase JSX elements (`<button>`, `<input>`, `<a>`, `<div>`, `<span>`, `<kbd>`, ...),
 *                          avoiding false positives on SDK/component wrappers (`<CopyButton>`, `<Card>`, `<TabsList>`)
 *                          and hyphenated domain classes (e.g. `chg-compact-slot-btn`, `sidebar-search-input`, `overview-card`).
 *
 * @typedef {'no-native-select' | 'no-search-input' | 'no-ui-emoji' | 'no-raw-control-class'} UiHygieneRule
 * @typedef {{ file: string, line: number, rule: UiHygieneRule, message: string }} UiHygieneViolation
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Matches colorful Emoji presentation codepoints, text-presentation pictographs paired with FE0F,
 * Regional Indicator flags, keycap Emoji sequences, and Misc Symbols / Emoji blocks while preserving
 * restrained UI typography (arrows → ← ↑ ↓, bullets •, ellipses …, dashes — –, math ± ≤ ≥ ≠, keycaps ⌘ ⌥ ⇧ ⌃, ✓ ✕ ×).
 */
export const UI_EMOJI_PATTERN =
  /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]\uFE0F?\u20E3|[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2764}])/u;

/**
 * Standalone host control and retired legacy container/modal/tab/kbd class tokens that must
 * come from `@helmx/ui` primitives rather than raw HTML tags.
 */
const RAW_CONTROL_CLASS_TOKEN_RE =
  /^(?:btn(?:-[a-z0-9_-]+)?|input(?:-sm)?|section-flat|form-grid|kv-list|tabs-bar|tab-btn|modal-header|modal-footer|dropdown-panel|kbd-hint|card)$/;

const CLASS_HELPER_NAMES = new Set(['clsx', 'cx', 'cn', 'joinClass', 'joinClasses', 'classNames']);

/** Placeholder substituted for `${...}` inside template literals when checking standalone class tokens. */
const TEMPLATE_EXPR_PLACEHOLDER = '___expr___';

function unwrapExpr(ts, expr) {
  let cur = expr;
  while (
    cur &&
    (ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isNonNullExpression(cur))
  ) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * Collect statically reachable string values produced by a JSX attribute expression
 * (skipping ternary conditions, comparison operands, and object index keys so expressions
 * like `kind === 'input' ? 'field-row' : 'other'` never false-positive).
 *
 * @param {typeof import('typescript')} ts
 * @param {import('typescript').Node} expr
 * @param {Array<{ text: string, node: import('typescript').Node }>} out
 */
function collectStringValues(ts, expr, out) {
  const cur = unwrapExpr(ts, expr);
  if (!cur) return;

  if (ts.isStringLiteral(cur) || ts.isNoSubstitutionTemplateLiteral(cur)) {
    out.push({ text: cur.text, node: cur });
    return;
  }

  if (ts.isTemplateExpression(cur)) {
    const headText = cur.head.text;
    let synthetic = headText;
    let prevEndsAttached = headText.length > 0 && !/\s$/.test(headText);
    for (const span of cur.templateSpans) {
      const spanValues = [];
      collectStringValues(ts, span.expression, spanValues);
      const literalText = span.literal.text;
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
        out.push({ text, node: v.node });
      }

      synthetic +=
        (startsWithBoundary ? ' ' : '') +
        TEMPLATE_EXPR_PLACEHOLDER +
        (endsWithBoundary ? ' ' : '') +
        literalText;

      prevEndsAttached = literalText.length > 0 ? !/\s$/.test(literalText) : !endsWithBoundary;
    }
    out.push({ text: synthetic, node: cur });
    return;
  }

  if (ts.isConditionalExpression(cur)) {
    collectStringValues(ts, cur.whenTrue, out);
    collectStringValues(ts, cur.whenFalse, out);
    return;
  }

  if (ts.isBinaryExpression(cur)) {
    const op = cur.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      collectStringValues(ts, cur.right, out);
    } else if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.PlusToken
    ) {
      collectStringValues(ts, cur.left, out);
      collectStringValues(ts, cur.right, out);
    }
    return;
  }

  if (ts.isArrayLiteralExpression(cur)) {
    for (const el of cur.elements) {
      if (ts.isSpreadElement(el)) collectStringValues(ts, el.expression, out);
      else collectStringValues(ts, el, out);
    }
    return;
  }

  if (ts.isCallExpression(cur)) {
    const callee = unwrapExpr(ts, cur.expression);
    if (ts.isIdentifier(callee) && CLASS_HELPER_NAMES.has(callee.text)) {
      for (const arg of cur.arguments) {
        if (ts.isSpreadElement(arg)) collectStringValues(ts, arg.expression, out);
        else collectStringValues(ts, arg, out);
      }
      return;
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (method === 'join' || method === 'filter' || method === 'trim') {
        collectStringValues(ts, callee.expression, out);
      }
    }
  }
}

function extractAttrStringValues(ts, initializer) {
  const out = [];
  if (!initializer) return out;
  if (ts.isStringLiteral(initializer)) {
    out.push({ text: initializer.text, node: initializer });
    return out;
  }
  if (ts.isJsxExpression(initializer) && initializer.expression) {
    collectStringValues(ts, initializer.expression, out);
  }
  return out;
}

function isModuleSpecifierLiteral(ts, node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node) return true;
  if (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node) return true;
  return false;
}

function findRawControlTokens(classText) {
  const matched = [];
  for (const rawToken of classText.split(/\s+/)) {
    if (!rawToken) continue;
    if (RAW_CONTROL_CLASS_TOKEN_RE.test(rawToken)) {
      matched.push(rawToken.replaceAll(TEMPLATE_EXPR_PLACEHOLDER, '${...}'));
    }
  }
  return matched;
}

/**
 * Analyze a single TSX source file for the 4 Helmx UI HIG static hygiene rules.
 *
 * @param {typeof import('typescript')} ts
 * @param {string} filePath
 * @param {string} source
 * @param {import('typescript').SourceFile} [existingSourceFile]
 * @returns {{ violations: UiHygieneViolation[] }}
 */
export function analyzeUiSource(ts, filePath, source, existingSourceFile = undefined) {
  const sourceFile =
    existingSourceFile ?? ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  /** @type {UiHygieneViolation[]} */
  const violations = [];
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node) => {
    // Rule 3: UI Emoji in JSX text or string/template literals (comments and regex literals are never visited here).
    if (
      ts.isJsxText(node) ||
      ((ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
        !isModuleSpecifierLiteral(ts, node))
    ) {
      const match = UI_EMOJI_PATTERN.exec(node.text);
      if (match) {
        violations.push({
          file: filePath,
          line: lineOf(node),
          rule: 'no-ui-emoji',
          message: `UI Emoji "${match[0]}" is forbidden (use plain text and <HelmxIcon> vector icons)`,
        });
      }
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = ts.isIdentifier(node.tagName) ? node.tagName.text : null;

      // Rule 1: Native <select> forbidden.
      if (tag === 'select') {
        violations.push({
          file: filePath,
          line: lineOf(node),
          rule: 'no-native-select',
          message: 'native <select> is forbidden (use @helmx/ui <Select> or <MultiSelect>)',
        });
      }

      // Rule 2: <input type="search"> forbidden.
      if (tag === 'input') {
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr) || !ts.isIdentifier(attr.name) || attr.name.text !== 'type') continue;
          const values = extractAttrStringValues(ts, attr.initializer);
          if (values.some((v) => v.text.trim().toLowerCase() === 'search')) {
            violations.push({
              file: filePath,
              line: lineOf(attr),
              rule: 'no-search-input',
              message: '<input type="search"> is forbidden (use @helmx/ui <SearchBox> or <Input type="text">)',
            });
            break;
          }
        }
      }

      // Rule 4: Raw control and retired legacy container/modal/tab/kbd class tokens bypassing SDK on intrinsic lowercase HTML elements.
      if (tag !== null && /^[a-z]/.test(tag)) {
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr) || !ts.isIdentifier(attr.name) || attr.name.text !== 'className') continue;
          const values = extractAttrStringValues(ts, attr.initializer);
          const badTokens = new Set();
          let firstLine = lineOf(attr);
          for (const value of values) {
            const found = findRawControlTokens(value.text);
            if (found.length > 0) {
              const valueLine = lineOf(value.node);
              if (badTokens.size === 0 || valueLine < firstLine) firstLine = valueLine;
              for (const token of found) badTokens.add(token);
            }
          }
          if (badTokens.size > 0) {
            violations.push({
              file: filePath,
              line: firstLine,
              rule: 'no-raw-control-class',
              message: `raw/legacy UI class token(s) [${[...badTokens].join(', ')}] on intrinsic <${tag}> bypass @helmx/ui primitives (use <Button>, <IconButton>, <Input>, <Card>, <Field>, <KvGrid>, <Tabs>, <ModalDialog>, <DropdownMenu>, or <Kbd>)`,
            });
          }
        }
      }
    }

    node.forEachChild(visit);
  };

  sourceFile.forEachChild(visit);
  violations.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  return { violations };
}

/**
 * Collect business UI TSX files across the repo:
 * - `packages/web/src/**\/*.tsx`
 * - `packages/plugins/src/*\/client/**\/*.tsx`
 * Returns sorted POSIX repo-relative paths.
 */
export function collectSourceUiFiles(repoRoot) {
  const files = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), `${prefix}/${entry.name}`);
      } else if (entry.isFile() && entry.name.endsWith('.tsx')) {
        files.push(`${prefix}/${entry.name}`);
      }
    }
  };

  walk(path.join(repoRoot, 'packages', 'web', 'src'), 'packages/web/src');

  const pluginsSrcDir = path.join(repoRoot, 'packages', 'plugins', 'src');
  let pluginEntries;
  try {
    pluginEntries = readdirSync(pluginsSrcDir, { withFileTypes: true });
  } catch {
    pluginEntries = [];
  }
  for (const entry of pluginEntries) {
    if (!entry.isDirectory()) continue;
    walk(
      path.join(pluginsSrcDir, entry.name, 'client'),
      `packages/plugins/src/${entry.name}/client`,
    );
  }

  return files.sort();
}
