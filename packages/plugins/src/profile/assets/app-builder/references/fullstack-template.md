# Minimal Runnable Full-Stack Micro-App Template

Start directly from this template; just replace the id, copy, and data structures. The template passes every `helmx plugins doctor <dir> --json` checkpoint (4 stages: manifest / backend / register / client, with non-empty `screens: ["main"]`) and installs directly via `helmx plugins install <dir> --enable`. Faster path: run `helmx plugins init <name> --dir <parentDir> --template app` to scaffold the exact same shape locally.

## Directory

```
apps/sample-desk/
  plugin.json
  index.ts
  client/index.tsx
```

## plugin.json

```json
{ "id": "sample-desk", "name": "Sample Desk", "main": "index.ts", "clientRoot": "./client", "version": "0.1.0" }
```

## index.ts (backend)

```ts
import { randomUUID } from 'node:crypto'
import type { PluginDefinition } from '@helmx/protocol'

export default {
  id: 'sample-desk',
  name: 'Sample Desk',
  description: 'Minimal full-stack micro-app template: persistent items + add/toggle + a main view.',
  version: '0.1.0',
  clientRoot: './client',
  definePlugin(ctx) {
    // Persistent business data: a public doc lets the frontend subscribe live via usePluginDoc
    const items = ctx.doc<{ list: Array<{ id: string; title: string; done: boolean; createdAt: number }> }>(
      'items',
      { list: [] },
      { public: true },
    )

    // Shared outputSchema: actions uniformly return { ok: true }
    const okSchema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    } as const

    ctx.action<{ title: string }, { ok: boolean }>({
      id: 'add_item',
      description: 'Add an item',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string', minLength: 1 } },
        required: ['title'],
        additionalProperties: false,
      },
      outputSchema: okSchema,
      exposeAsTool: true,
      async handler(input) {
        items.update((current) => ({
          list: [
            { id: randomUUID(), title: input.title, done: false, createdAt: Date.now() },
            ...current.list,
          ],
        }))
        await items.flush() // flush after writes (honesty: never claim persisted when it is not)
        return { ok: true }
      },
    })

    ctx.action<{ id: string; done: boolean }, { ok: boolean }>({
      id: 'set_done',
      description: 'Check/uncheck an item',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, done: { type: 'boolean' } },
        required: ['id', 'done'],
        additionalProperties: false,
      },
      outputSchema: okSchema, // single-point Schema contract: input/output must both be declared
      exposeAsTool: true,
      async handler(input) {
        items.update((current) => ({
          list: current.list.map((it) => (it.id === input.id ? { ...it, done: input.done } : it)),
        }))
        await items.flush()
        return { ok: true }
      },
    })

    // Full-stack micro-app requirement: at least one ctx.ui.screen (surfaced under Plugin Center -> With views;
    // optionally declare ctx.ui.sidebarItem({ target: 'screen:sample-desk/main', ... }) only if a sidebar shortcut is wanted)
    ctx.ui.screen({
      id: 'main',
      label: 'Sample Desk',
      client: { module: 'index.tsx', export: 'MainScreen' },
    })
  },
} satisfies PluginDefinition
```

## client/index.tsx (frontend: reuse `@helmx/plugin-client` primitives and host public CSS classes; no private stylesheet by default)

```tsx
import { useState, type ReactNode } from 'react'
import {
  usePluginContext,
  usePluginDoc,
  Screen,
  ScreenSection,
  DataTable,
  Checkbox,
  Button,
  Field,
  Input,
} from '@helmx/plugin-client'

interface Item { id: string; title: string; done: boolean; createdAt: number }

export function MainScreen(): ReactNode {
  const { callAction, notify } = usePluginContext()
  const doc = usePluginDoc<{ list: Item[] }>('items')
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)

  const list = doc?.list ?? []
  const doneCount = list.filter((it) => it.done).length

  const add = async () => {
    const title = draft.trim()
    if (title === '') return
    setPending(true)
    try {
      await callAction('add_item', { title })
      setDraft('')
    } catch (err) {
      notify('Add failed: ' + (err instanceof Error ? err.message : String(err)), 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <Screen title="Sample Desk" subtitle={'Done ' + doneCount + ' / ' + list.length}>
      <ScreenSection
        title="Add an item"
        titleExtra={
          <Button
            variant="primary"
            size="sm"
            pending={pending}
            disabled={draft.trim() === ''}
            onClick={() => void add()}
          >
            Add
          </Button>
        }
      >
        <Field label="Item title">
          <Input
            value={draft}
            placeholder="Type a todo and press Enter..."
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
          />
        </Field>
      </ScreenSection>

      <ScreenSection title="Item list">
        <DataTable loading={doc === undefined} empty={list.length === 0} emptyLabel="No items yet" columns={2}>
          <thead>
            <tr>
              <th>Status</th>
              <th>Content</th>
            </tr>
          </thead>
          <tbody>
            {list.map((it) => (
              <tr key={it.id}>
                <td>
                  <Checkbox
                    checked={it.done}
                    onChange={(checked) => {
                      void callAction('set_done', { id: it.id, done: checked }).catch((err: unknown) =>
                        notify('Update failed: ' + (err instanceof Error ? err.message : String(err)), 'error'),
                      )
                    }}
                  />
                </td>
                <td>{it.title}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </ScreenSection>
    </Screen>
  )
}
```

## Verify and install

```bash
helmx plugins doctor /abs/path/to/apps/sample-desk --json   # check ok: true and screens: ["main"]
helmx plugins install /abs/path/to/apps/sample-desk --enable --json
```

After editing source files, re-run `helmx plugins doctor` and `helmx plugins install /abs/path/to/apps/sample-desk --enable` to hot-update in place while preserving existing `ctx.doc` data.

## Styling rules

- Default to zero private CSS: compose layout with SDK primitives (`Screen` header `actions`, `ScreenSection` `titleExtra`, `DataTable`, `KvGrid`) and host public classes (`.input`, `.btn btn-primary`, `.stack-row`, `.loading-state`, `.callout`); never re-declare form controls with custom classes.
- Add a scoped custom stylesheet only when the host vocabulary is genuinely insufficient, and keep it limited to layout/branding on your own class names with host CSS variables (`var(--fg)`, `var(--border)`, ...).

## Checklist cross-reference

- `index.ts` (and `plugin.json`) declares `clientRoot: './client'` explicitly (when undeclared the default root is the plugin directory itself, and `client/index.tsx` cannot be found);
- Backend `ctx.doc('items', ..., { public: true })` + `flush()` after writes;
- `ctx.action` declares both `inputSchema` and `outputSchema` (the single-point Schema contract; missing ones are rejected at register), with `exposeAsTool: true`;
- The frontend prefers reusing `@helmx/plugin-client` layout primitives `Screen / ScreenSection / DataTable / KvGrid` and accessible controls (`Checkbox` uses `onChange(checked)`; notifications use `notify(message, tone)`), without introducing undeclared bare npm packages;
- Zero private stylesheet by default (host public `.input` / `.btn` classes + SDK primitives; add scoped CSS only when the vocabulary is insufficient);
- `ctx.ui.screen({ id: 'main', client: { module: 'index.tsx', export: 'MainScreen' } })` and the frontend really exports `MainScreen` (`helmx plugins doctor` reports `screens: ["main"]`);
- No `sidebarItem` registered by default (avoiding sidebar bloat; the optional sidebar entry in the `helmx plugins init --template app` skeleton can be removed as needed); no Emoji; styling uses host CSS variables.
