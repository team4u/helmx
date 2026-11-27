/**
 * Synchronized host/plugin CSS scoping contract tests:
 * - Host stylesheets declare `@layer ui-base, ui-primitives, host-components, plugin-ui;`,
 *   and `scopePluginCss` wraps plugin CSS inside `@layer plugin-ui { ... }`
 *   with zero-specificity `:where([data-plugin-id="..."])` scoping and
 *   per-plugin `@keyframes` isolation across inline subtrees and portals;
 * - Real happy-dom `getComputedStyle` verification proves layered host-vs-plugin
 *   cascade priority, cross-plugin & plugin-to-host isolation, and portal style
 *   propagation.
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { renderToString } = await import('react-dom/server')
const { PluginClientContext } = await import('../src/plugin-context.js')
const { PluginScope } = await import('../src/ui/PluginScope.js')
const { scopePluginCss } = await import('../src/ui/plugin-css-scope.js')
const { Dialog, DialogContent, DialogOverlay, DialogPortal, DialogTitle } = await import('@helmx/ui')

const e = React.createElement

function makePluginCtx(pluginId: string) {
  return {
    pluginId,
    callAction: async () => ({}),
    fetchRoute: async () => { throw new Error('fetchRoute not implemented in test stub') },
    submitInput: async () => {},
    openScreen: () => {},
    openSplitScreen: () => {},
    openConversationDrawer: () => {},
    openArtifact: () => {},
    openWorkbench: () => {},
    closeWorkbench: () => {},
    notify: () => {},
    getPluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    theme: 'dark' as const,
    locale: 'en' as const,
    translate: (text: unknown) => (typeof text === 'string' ? text : ''),
  }
}

test('PluginScope SSR: renders display:contents anchor inside plugin context and passes through unwrapped outside', { timeout: 60_000 }, () => {
  const outside = renderToString(e(PluginScope, null, e('span', { className: 'host-chip' }, 'Host')))
  assert.doesNotMatch(outside, /data-plugin-id/)
  assert.match(outside, /host-chip/)

  const inside = renderToString(
    e(
      PluginClientContext.Provider,
      { value: makePluginCtx('builtin:triggers') },
      e(PluginScope, null, e('span', { className: 'app-chip' }, 'App')),
    ),
  )
  assert.match(inside, /data-plugin-id="builtin:triggers"/)
  assert.match(inside, /display:contents/)

  const explicit = renderToString(
    e(PluginScope, { pluginId: 'ext:custom' }, e('span', null, 'Custom')),
  )
  assert.match(explicit, /data-plugin-id="ext:custom"/)
})

test('scopePluginCss: wraps in @layer plugin-ui, scopes selectors & @keyframes/animation names, and is idempotent', { timeout: 60_000 }, () => {
  const raw = `
    /* header comment with { braces } and , commas */
    :root { --my-accent: #123456; }
    .card, .card:hover { color: red; content: "a, {b}"; animation: spin 1s linear infinite, fadeIn 200ms ease-out; }
    button.primary { font-weight: 600; animation-name: spin; }
    @media (max-width: 680px) {
      .grid { display: block; }
    }
    @container panel (max-width: 500px) {
      .row { gap: 4px; }
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
  `
  const scoped = scopePluginCss(raw, 'builtin:alpha')
  assert.match(scoped, /^@layer plugin-ui \{[\s\S]*\}$/, 'plugin CSS must be wrapped in @layer plugin-ui')
  assert.match(scoped, /:where\(\[data-plugin-id="builtin:alpha"\]\)\s*\{\s*--my-accent: #123456;\s*\}/)
  assert.match(scoped, /:where\(\[data-plugin-id="builtin:alpha"\]\) \.card, :where\(\[data-plugin-id="builtin:alpha"\]\)\.card/)
  assert.match(scoped, /:where\(\[data-plugin-id="builtin:alpha"\]\) button\.primary, button:where\(\[data-plugin-id="builtin:alpha"\]\)\.primary/)
  assert.match(scoped, /@media \(max-width: 680px\)\s*\{[\s\S]*?:where\(\[data-plugin-id="builtin:alpha"\]\) \.grid/)
  assert.match(scoped, /@container panel \(max-width: 500px\)\s*\{[\s\S]*?:where\(\[data-plugin-id="builtin:alpha"\]\) \.row/)

  // Keyframe names are scoped per plugin and animation references are rewritten.
  const scopedBeta = scopePluginCss('@keyframes spin { from { opacity: 0; } to { opacity: 1; } } .x { animation: spin 1s linear; }', 'builtin:beta')
  const alphaKf = scoped.match(/@keyframes\s+([a-zA-Z0-9_-]+)/)?.[1]
  const betaKf = scopedBeta.match(/@keyframes\s+([a-zA-Z0-9_-]+)/)?.[1]
  assert.ok(alphaKf !== undefined && alphaKf.endsWith('-spin') && alphaKf !== 'spin')
  assert.ok(betaKf !== undefined && betaKf.endsWith('-spin') && betaKf !== 'spin')
  assert.notEqual(alphaKf, betaKf, 'distinct plugins must get distinct @keyframes identifiers')
  assert.match(scoped, new RegExp(`animation:\\s*${alphaKf} 1s linear infinite, [a-zA-Z0-9_-]+-fadeIn 200ms ease-out;`))
  assert.match(scoped, new RegExp(`animation-name:\\s*${alphaKf};`))

  // Leading @charset / @import stay outside @layer plugin-ui.
  const withCharset = scopePluginCss('@charset "utf-8";\n.foo { color: red; }', 'ext:c')
  assert.match(withCharset, /^@charset "utf-8";\s*@layer plugin-ui \{/)

  // Idempotence: scoping a second time produces identical output.
  const scopedTwice = scopePluginCss(scoped, 'builtin:alpha')
  assert.equal(scopedTwice, scoped)
})

/**
 * Happy-dom's CSSOM parser drops `@layer <name> { ... }` blocks; unwrap top-level
 * `@layer` wrappers only when feeding rules into happy-dom's selector engine so
 * we can verify real DOM `:where([data-plugin-id="..."])` isolation alongside
 * the `@layer plugin-ui` output assertions.
 */
function unwrapLayersForHappyDom(css: string): string {
  return css
    .replace(/@layer\s+[^{;]+;/g, '')
    .replace(/@layer\s+[^{]+\{([\s\S]*)\}\s*$/m, '$1')
}

test('scopePluginCss DOM: layered ui-base/ui-primitives/host-components/plugin-ui isolates subtrees and portals with predictable cascade', { timeout: 60_000 }, async () => {
  const hostStyle = document.createElement('style')
  const rawHostCss = `
    @layer ui-base, ui-primitives, host-components, plugin-ui;
    @layer host-components {
      .box { color: rgb(10, 10, 10); }
      .modal { color: rgb(20, 20, 20); }
    }
  `
  const scopedPluginACss = scopePluginCss(
    `
      .box { color: rgb(1, 2, 3); }
      .box.box-accent { color: rgb(4, 5, 6); }
      .my-portal { color: rgb(7, 8, 9); }
      .my-portal .inner-note { color: rgb(11, 22, 33); }
    `,
    'ext:alpha',
  )
  assert.match(scopedPluginACss, /^@layer plugin-ui \{[\s\S]*\}$/)
  hostStyle.textContent = unwrapLayersForHappyDom(rawHostCss)
  const pluginAStyle = document.createElement('style')
  pluginAStyle.textContent = unwrapLayersForHappyDom(scopedPluginACss)
  document.head.append(hostStyle, pluginAStyle)

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        e(
          React.Fragment,
          null,
          e('div', { className: 'box', id: 'host-box' }, 'Host'),
          e(
            PluginClientContext.Provider,
            { value: makePluginCtx('ext:alpha') },
            e(
              PluginScope,
              null,
              e('div', { className: 'box', id: 'alpha-box' }, 'Alpha'),
              e('div', { className: 'box box-accent', id: 'alpha-accent' }, 'Alpha Accent'),
              e(
                Dialog,
                { open: true },
                e(
                  DialogPortal,
                  null,
                  e(DialogOverlay, null),
                  e(
                    DialogContent,
                    { className: 'modal my-portal', id: 'alpha-portal' },
                    e(DialogTitle, null, 'Alpha Modal'),
                    e('p', { className: 'inner-note', id: 'alpha-portal-note' }, 'Note'),
                  ),
                ),
              ),
            ),
          ),
          e(
            PluginClientContext.Provider,
            { value: makePluginCtx('ext:beta') },
            e(PluginScope, null, e('div', { className: 'box', id: 'beta-box' }, 'Beta')),
          ),
        ),
      )
    })

    const hostBox = document.getElementById('host-box')!
    const alphaBox = document.getElementById('alpha-box')!
    const alphaAccent = document.getElementById('alpha-accent')!
    const betaBox = document.getElementById('beta-box')!
    const alphaPortal = document.getElementById('alpha-portal')!
    const alphaPortalNote = document.getElementById('alpha-portal-note')!

    assert.equal(getComputedStyle(hostBox).color, 'rgb(10, 10, 10)', 'plugin A CSS must never leak onto host chrome')
    assert.equal(getComputedStyle(betaBox).color, 'rgb(10, 10, 10)', 'plugin A CSS must never leak onto plugin B')
    assert.equal(getComputedStyle(alphaBox).color, 'rgb(1, 2, 3)', 'plugin-ui layer cleanly overrides host-components')
    assert.equal(getComputedStyle(alphaAccent).color, 'rgb(4, 5, 6)', 'intra-plugin specificity is preserved under :where(...)')
    assert.equal(alphaPortal.getAttribute('data-plugin-id'), 'ext:alpha', 'portalled DialogContent carries data-plugin-id')
    assert.equal(getComputedStyle(alphaPortal).color, 'rgb(7, 8, 9)', 'portalled DialogContent root matches self-scoped plugin selector')
    assert.equal(getComputedStyle(alphaPortalNote).color, 'rgb(11, 22, 33)', 'descendants inside portalled DialogContent match scoped selector')
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    hostStyle.remove()
    pluginAStyle.remove()
  }
})

test('scopePluginCss: quote-aware comment stripping preserves /* */ inside strings and rewrites nested rule animations', { timeout: 60_000 }, () => {
  const raw = `
    @keyframes fadeSpin {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .badge[data-glob="/*keep*/"] /* real comment */ {
      content: "/*also-keep*/";
      animation: fadeSpin 1s ease-in;
      &:hover {
        color: blue;
        animation-name: fadeSpin;
      }
      @media (max-width: 640px) {
        animation: fadeSpin 400ms linear;
      }
    }
  `
  const scoped = scopePluginCss(raw, 'ext:nested')
  assert.match(scoped, /\[data-glob="\/\*keep\*\/"\]/, 'attribute selector string literal containing /* */ must remain intact')
  assert.doesNotMatch(scoped, /real comment/, 'actual comment in selector prelude is stripped')
  assert.match(scoped, /content:\s*"\/\*also-keep\*\/";/, 'declaration string literal containing /* */ must remain intact')

  const kfMatch = scoped.match(/@keyframes\s+([a-zA-Z0-9_-]+)/)
  assert.ok(kfMatch !== null && kfMatch[1] !== undefined)
  const scopedName = kfMatch[1]
  assert.match(scoped, new RegExp(`animation:\\s*${scopedName} 1s ease-in;`))
  assert.match(scoped, new RegExp(`&:hover\\s*\\{[\\s\\S]*?animation-name:\\s*${scopedName};`))
  assert.match(scoped, new RegExp(`@media \\(max-width: 640px\\)\\s*\\{[\\s\\S]*?animation:\\s*${scopedName} 400ms linear;`))
})

test('scopePluginCss: selector lists split only on top-level commas; parens, brackets, strings, and comments stay intact', { timeout: 60_000 }, () => {
  const scope = ':where([data-plugin-id="builtin:alpha"])'
  const scoped = scopePluginCss(
    ':is(.a, .b):not(.c, .d), [data-tags="x,y"], .lead /* drop, me */ .tail { color: red; }',
    'builtin:alpha',
  )
  // Three top-level selectors survive; the comment (and its comma) is stripped, leaving `.lead  .tail`.
  assert.equal(
    scoped,
    `@layer plugin-ui {\n${scope} :is(.a, .b):not(.c, .d), ${scope}:is(.a, .b):not(.c, .d), ` +
      `${scope} [data-tags="x,y"], ${scope}[data-tags="x,y"], ${scope} .lead  .tail, ${scope}.lead  .tail { color: red; }\n}`,
  )

  // Parens and brackets are tracked separately: a stray `]` does not close `:not(`, so the comma stays inside it.
  const strayCloser = scopePluginCss('a:not(b], c) { color: blue; }', 'builtin:alpha')
  assert.equal(strayCloser, `@layer plugin-ui {\n${scope} a:not(b], c), a${scope}:not(b], c) { color: blue; }\n}`)
})
