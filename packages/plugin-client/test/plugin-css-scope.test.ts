/**
 * Synchronized host/plugin CSS scoping contract tests:
 * - Zero-specificity `:where([data-plugin-id="..."])` scoping avoids unilateral
 *   `@layer` cascade inversions while isolating plugin CSS across inline
 *   subtrees (`PluginScope` / `Screen`) and portalled overlays (`Dialog`,
 *   `Popover`, `DropdownMenu`, `Tooltip`, `Select`);
 * - Real happy-dom `getComputedStyle` verification proves cross-plugin and
 *   plugin-to-host isolation plus portal style propagation.
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
const { Dialog, DialogContent, DialogOverlay, DialogPortal, DialogTitle } = await import('../src/ui/Dialog.js')

const e = React.createElement

function makePluginCtx(pluginId: string) {
  return {
    pluginId,
    callAction: async () => ({}),
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
      { value: makePluginCtx('builtin:apps') },
      e(PluginScope, null, e('span', { className: 'app-chip' }, 'App')),
    ),
  )
  assert.match(inside, /data-plugin-id="builtin:apps"/)
  assert.match(inside, /display:contents/)

  const explicit = renderToString(
    e(PluginScope, { pluginId: 'ext:custom' }, e('span', null, 'Custom')),
  )
  assert.match(explicit, /data-plugin-id="ext:custom"/)
})

test('scopePluginCss: scopes selectors, conditional at-rules, and :root without mutating keyframes or re-scoping', { timeout: 60_000 }, () => {
  const raw = `
    /* header comment with { braces } and , commas */
    :root { --my-accent: #123456; }
    .card, .card:hover { color: red; content: "a, {b}"; }
    button.primary { font-weight: 600; }
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
  `
  const scoped = scopePluginCss(raw, 'builtin:alpha')
  assert.match(scoped, /:where\(\[data-plugin-id="builtin:alpha"\]\)\s*\{\s*--my-accent: #123456;\s*\}/)
  assert.match(scoped, /:where\(\[data-plugin-id="builtin:alpha"\]\) \.card, :where\(\[data-plugin-id="builtin:alpha"\]\)\.card/)
  assert.match(scoped, /:where\(\[data-plugin-id="builtin:alpha"\]\) button\.primary, button:where\(\[data-plugin-id="builtin:alpha"\]\)\.primary/)
  assert.match(scoped, /@media \(max-width: 680px\)\s*\{[\s\S]*?:where\(\[data-plugin-id="builtin:alpha"\]\) \.grid/)
  assert.match(scoped, /@container panel \(max-width: 500px\)\s*\{[\s\S]*?:where\(\[data-plugin-id="builtin:alpha"\]\) \.row/)
  assert.match(scoped, /@keyframes spin\s*\{\s*from \{ transform: rotate\(0deg\); \}\s*to \{ transform: rotate\(360deg\); \}\s*\}/)
  assert.doesNotMatch(scoped, /@layer/, 'must never wrap plugin CSS in unilateral @layer')

  // Idempotence: scoping a second time produces identical selectors
  const scopedTwice = scopePluginCss(scoped, 'builtin:alpha')
  assert.equal(scopedTwice, scoped)
})

test('scopePluginCss DOM: isolates inline subtrees and portalled dialogs across plugins and preserves specificity', { timeout: 60_000 }, async () => {
  const hostStyle = document.createElement('style')
  // Unlayered host base rule
  hostStyle.textContent = '.box { color: rgb(10, 10, 10); } .modal { color: rgb(20, 20, 20); }'
  const pluginAStyle = document.createElement('style')
  pluginAStyle.textContent = scopePluginCss(
    `
      .box { color: rgb(1, 2, 3); }
      .box.box-accent { color: rgb(4, 5, 6); }
      .my-portal { color: rgb(7, 8, 9); }
      .my-portal .inner-note { color: rgb(11, 22, 33); }
    `,
    'ext:alpha',
  )
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
    assert.equal(getComputedStyle(alphaBox).color, 'rgb(1, 2, 3)', 'plugin A inline element receives plugin A style without @layer inversion')
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
