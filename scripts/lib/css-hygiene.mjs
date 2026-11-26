/**
 * Static CSS source hygiene (pure text scan, zero dependencies).
 *
 * Covers the statically decidable rule from AGENTS §5:
 *   hover-media-gate  every style rule whose selector list contains :hover must be nested in
 *                      @media (hover: hover) (real hover capability only) or in an explicit
 *                      @media (hover: none) override. Touch browsers keep :hover stuck on the
 *                      tapped element until the next tap elsewhere, which shows up as "stays
 *                      highlighted after tap" on phones. :not(:hover) is not a hover highlight,
 *                      @keyframes frames are not selectors, and (any-hover: hover) is not an
 *                      accepted gate: a touch-primary device with a mouse attached still sticks.
 *
 * @typedef {{ line: number, selector: string }} HoverGateViolation
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';

const HOVER_MEDIA_RE = /\(\s*hover\s*:\s*(hover|none)\s*\)/;

function selectorHasHover(selector) {
  let rest = selector;
  let prev;
  do {
    prev = rest;
    rest = rest.replace(/:not\([^()]*\)/g, '');
  } while (rest !== prev);
  return /:hover\b/.test(rest);
}

/** Blank comment bodies and string literals (newlines preserved so line numbers stay exact). */
function blankCommentsAndStrings(css) {
  return css.replace(
    /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g,
    (match) => match.replace(/[^\n]/g, ' '),
  );
}

/** Report every style rule whose selector contains :hover outside a hover media gate. */
export function findUngatedHoverRules(css) {
  const text = blankCommentsAndStrings(css);
  /** @type {HoverGateViolation[]} */
  const violations = [];
  /** @type {Array<{ hoverGate: boolean, keyframes: boolean }>} */
  const stack = [];
  let prelude = '';
  let preludeLine = 1;
  let line = 1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\n') line += 1;
    if (ch === '{') {
      const head = prelude.trim();
      const frame = { hoverGate: false, keyframes: false };
      if (head.startsWith('@')) {
        const name = /^@([a-zA-Z-]+)/.exec(head);
        const kind = name ? name[1].toLowerCase() : '';
        if (kind === 'media') frame.hoverGate = HOVER_MEDIA_RE.test(head);
        else if (kind.endsWith('keyframes')) frame.keyframes = true;
      } else if (head !== '' && selectorHasHover(head) && !stack.some((f) => f.hoverGate || f.keyframes)) {
        violations.push({ line: preludeLine, selector: head.replace(/\s+/g, ' ').slice(0, 120) });
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

/** Collect source stylesheets: every .css under packages/<name>/src (recursive); test fixtures and dist are out of scope. */
export function collectSourceCssFiles(repoRoot) {
  const packagesDir = path.join(repoRoot, 'packages');
  let entries;
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  const walk = (dir, prefix) => {
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (child.isDirectory()) walk(path.join(dir, child.name), `${prefix}/${child.name}`);
      else if (child.isFile() && child.name.endsWith('.css')) files.push(`${prefix}/${child.name}`);
    }
  };
  for (const entry of entries) {
    if (entry.isDirectory()) walk(path.join(packagesDir, entry.name, 'src'), `packages/${entry.name}/src`);
  }
  return files.sort();
}
