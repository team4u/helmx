/**
 * Kernel-owned `app-builder` managed skill (`managedByPlugin: core:plugins`).
 *
 * Covers L1 ephemeral UI cards vs L2 full-stack micro-apps (screen-bearing external Helmx plugins),
 * directory conventions, the mandatory `doctor` / `install` SOP, and a complete runnable template.
 */
import type { BuiltinSkillAsset } from '../../services/skill-service.js'
import { renderSkillTemplate } from './template.js'

export const APP_BUILDER_SKILL_ID = 'app-builder'
export const APP_BUILDER_SKILL_OWNER = 'core:plugins'

const APP_BUILDER_SKILL_TEMPLATE = `---
name: {{SKILL_ID}}
description: Use when building reusable full-stack micro-apps (tool desks, boards, reconciliation desks, trackers with frontend, backend, and persistent state) as standard screen-bearing Helmx plugins; covers L1 ephemeral cards vs L2 full-stack apps selection, directory conventions, the doctor/install SOP, and code templates.
managedByPlugin: {{MANAGED_BY}}
---

# Building Full-Stack Micro-Apps (Screen-Bearing Plugins)

When the user needs a tool that is "reusable, with its own UI and persistent data", deliver it as a standard screen-bearing external Helmx plugin per this skill's SOP. Installed micro-apps are managed and launched directly from **Plugin Center** (filtered under **With views** / **应用视图**, with one-click **Open view** and **Open in split**).

## L1 or L2: choose first

- **L1 ephemeral card (\`\`\`ui code block)**: data tables, metrics, and confirmation forms shown once inside the current conversation; they sink with the conversation, with no persistent state and no backend logic. See the \`generative-ui\` skill (\`load_skill({ skillId: "generative-ui" })\`) when available in this turn's skill catalog.
- **L2 full-stack micro-app (this skill)**: tool desks the user explicitly wants to "save/install/open again later", or that need cross-conversation persistent data, custom backend actions, or a standalone UI. The artifact is a standard Helmx plugin package declaring at least one \`ctx.ui.screen\`, installed via \`helmx plugins install\`.

When unsure, ask the user one question; do not guess for them.

## L2 Delivery SOP (four steps, no skipping)

### 1. Planning and directory initialization

Scaffold directly with the CLI (or create under \`<cwd>/apps/<app-id>/\`):

\`\`\`bash
helmx plugins init <app-id> --dir <parentDir> --template app --json
\`\`\`

Directory layout:

\`\`\`
<parentDir>/<app-id>/
  plugin.json          # { "id": "<app-id>", "main": "index.ts", "clientRoot": "./client" }
  index.ts             # backend: clientRoot: "./client" + ctx.doc / ctx.action / ctx.ui.screen
  tsconfig.json        # local typecheck config
  client/index.tsx     # frontend: main Screen component (zero private stylesheet by default)
\`\`\`

- \`app-id\` uses kebab-case (e.g. \`bill-desk\`); the \`builtin:\` prefix and colons (\`:\`) are forbidden;
- **clientRoot is required**: when frontend components live in a \`client/\` subdirectory, \`index.ts\`'s \`PluginDefinition\` (and \`plugin.json\`) must declare \`clientRoot: './client'\` explicitly -- when undeclared the default root is the plugin directory itself, and \`helmx plugins doctor\` fails with a missing client module because it cannot find \`index.tsx\`;
- UI copy and icons follow the zero-Emoji iron rule; icons use lucide icon names (e.g. \`layout-grid\`, \`list-checks\`, \`wallet\`).

### 2. Full-stack coding constraints and the shared SDK

Backend \`index.ts\` (a standard \`PluginDefinition\`):

- \`ctx.doc('<name>', initialState, { public: true })\` persists global data; use \`ctx.sessionDoc('<name>', initialState, { public: true })\` for per-conversation state; **\`await doc.flush()\` after writes**;
- \`ctx.action({ id, description, inputSchema, outputSchema, idempotent?, exposeAsTool: true, handler })\`: actions must declare **both \`inputSchema\` and \`outputSchema\`** (read-only actions use \`idempotent: true\`); the handler may call \`ctx.host.execEnv\` to run commands across nodes; actions automatically get the HTTP / CLI / Agent Tool / Workflow / Web five-end mapping;
- **You must register at least one \`ctx.ui.screen({ id: 'main', label: '...', client: { module: 'index.tsx', export: 'MainScreen' } })\`** -- this is what turns the plugin into an openable micro-app in Plugin Center (under the **With views** tab);
- \`ctx.ui.sidebarItem\` is optional: omit or remove it unless the user explicitly asks for a permanent left-sidebar shortcut (Plugin Center already exposes **Open view** and **Open in split** for every active screen-bearing plugin, preventing sidebar bloat).

Frontend \`client/index.tsx\` (host shared SDK, import directly without installing):

- **Mandatory UI HIG gate (read BEFORE writing any \`client/*.tsx\`)**:
  \`\`\`
  load_skill({ skillId: "helmx-cli", path: "references/ui-hig.md" })
  \`\`\`
  Follow the single Helmx UI HIG (Quiet Surface principles, \`32 / 28 / 22px\` control scale, 5-variant \`Button\` with \`secondary\` default and **zero \`variant="default"\`**, 4-way selector rules, 5 first-class stage/list archetypes plus custom domain stages, unified \`<Screen toolbar>\` shell, container density rules, Creative Zone boundaries, and canonical JSX patterns).
- **The only allowed runtime bare imports are host shared modules**: \`react\`, \`react-dom\`, \`lucide-react\`, \`@helmx/plugin-client\`; types may use \`import type ... from '@helmx/protocol'\`. For third-party npm packages, declare each one in \`plugin.json.clientDependencies\` or \`package.json.helmx.clientDependencies\` first, then state the version range in \`package.json.dependencies\`; otherwise \`helmx plugins doctor\` fails explicitly on undeclared bare dependencies.
- **The \`@helmx/plugin-client\` shared export list**:
  - **Reactive hooks**: \`usePluginContext()\` (provides \`callAction\` / \`fetchRoute\` / \`submitInput\` / \`openScreen\` / \`openSplitScreen\` / \`openConversationDrawer\` / \`openArtifact\` / \`openWorkbench\` / \`notify\`), \`usePluginDoc(name, pluginId?)\`, \`usePluginSessionDoc(name, opts?)\`, \`useHostModels()\`, \`useHostNodes()\`, \`useHostProfiles()\`, \`useConversations()\`, \`useConversation(id)\`, \`usePlugins()\`, \`useScreenParams()\`, \`useScreenDrawer(options?)\` (pairs with \`DetailDrawer\` for URL-hash-backed mobile/browser Back navigation), \`usePluginAction()\`, \`usePluginLocale()\`, \`usePluginTranslator()\`, \`useToolActivity(callId, active)\`;
  - **Page shell & stage layout primitives (prefer these over hand-rolled page scaffolding)**: \`Screen\` (single unified page shell: \`layout="contained" | "full-bleed"\`, \`title/subtitle/actions\`, and sticky full-bleed \`toolbar={<ScreenToolbar ...>}\`), \`ScreenSection\` (section container \`title/titleExtra\`), \`ScreenToolbar\` (single-layer left-filters / right-search toolbar), \`List\` + \`ListRow\` (Hairline Roster List for items, rules, configs, and logs with sibling-slot a11y and \`@container\` narrow-pane collapse), \`Card\` / \`SelectCard\` (\`icon\`, \`badges\`, \`description\`, \`actions\`, \`footer\`) / \`CardGrid\` (browsable asset/catalog grids), \`DataTable\` (multi-column numeric comparison only; narrow panels \`< 560px\` capped at 3 columns), \`KvGrid\` (\`items: [{ key, value }]\` key-value grid), \`DetailDrawer\` (right slide-over drawer; pair with \`useScreenDrawer()\` in \`Screen\` views);
  - **Accessible controls, forms, and display components**: \`HelmxIcon\`, \`Button\` / \`IconButton\` (5 orthogonal variants: \`secondary\` [Button default] | \`primary\` | \`ghost\` [IconButton default] | \`danger\` | \`inline\` — never \`variant="default"\`; sizes \`md\` 32px / \`sm\` 28px / \`xs\` 22px; \`pending\` busy state), \`Badge\` (sharp \`5px\` tags), \`Kbd\` (\`size?: 'sm' | 'md'\`, \`desktopOnly?\` keyboard shortcut badge — never raw \`.kbd-hint\`), \`Stack\` (spacing-token flex layout), \`Input\` (\`size\`, native \`prefix\` / \`suffix\`, \`mono\`, \`invalid\`) / \`Textarea\`, \`Field\` / \`HelperText\` / \`ErrorText\` (non-wrapping label + automatic \`FieldContext\` wiring), \`ModelPickerControl\` (pass \`variant="field"\` in forms/drawers), \`MonoId\`, \`Switch\`, \`Select\`, \`MultiSelect\`, \`Checkbox\`, \`Tabs / TabsList / TabsTrigger / TabsContent / TabCount\` (\`underline | segmented | pills\` with zero \`variant="default"\`; \`underline\` + \`TabsList scrollable\` strictly for container/drawer divider tab bars), \`SegmentedControl\`, \`ModalDialog\` (centered modal shell \`size="sm|md|lg|fullscreen"\` with \`icon\`/\`titleExtra\`/\`description\`/\`headerActions\`/\`footer\` — use instead of raw \`.modal-header\`/\`.modal-footer\`), \`Dialog / DialogTrigger / DialogContent / DialogTitle / DialogDescription / DialogClose\`, \`DropdownMenu / DropdownMenuItem\` (structured \`icon\`/\`description\`/\`shortcut\`/\`trailing\`/\`checked\`/\`danger\` slots), \`AlertDialog\` / \`ConfirmDialog\`, \`SearchBox\` (\`variant="toolbar" size="sm"\` in toolbars, \`surface="default | subtle | frameless"\` for sidebars/popovers/palettes; never native \`<input type="search">\`), \`EmptyState\` (\`compact\` / \`prominent\`), \`LoadingState\`, \`StatusLight\` (explicit \`tone: StatusLightTone\` or raw \`status\`, plus \`STATUS_LIGHT_TONES\` / \`normalizeStatusLightTone\` / \`isKnownStatusLightStatus\`), \`Callout\`, \`MarkdownView\`, \`MarkdownText\`, \`CodeBlockView\`, \`CopyButton\`, \`ViewBoundary\`, \`PluginSlot\`;
- Styling defaults to zero private CSS: compose layout and forms with SDK primitives (\`Screen\`, \`ScreenSection\`, \`ScreenToolbar\`, \`List\`, \`ListRow\`, \`Stack\`, \`Card\`, \`SelectCard\`, \`CardGrid\`, \`Field\`, \`Input\`, \`Textarea\`, \`Button\`, \`IconButton\`, \`Badge\`, \`MonoId\`, \`DataTable\`, \`KvGrid\`, \`DetailDrawer\`) and host spacing/color CSS variables (\`--space-1..6\`, \`--bg-elevated\`, \`--border\`, ...); add a scoped \`client/styles.css\` (bundled via \`import './styles.css'\`) only when the host vocabulary is genuinely insufficient, gate every \`:hover\` inside \`@media (hover: hover)\`, limit it to your own class names, and never write the host's \`styles.css\`;
- Component files export only components and types (Fast Refresh); the \`module\` path and named \`export\` referenced by \`client\` must match reality (\`helmx plugins doctor\` validates compiled artifact exports).

Full runnable template: \`load_skill({ skillId: "app-builder", path: "references/fullstack-template.md" })\`; for advanced extension points (backend lifecycle hooks, \`composerCompleter\`, workbench panels, etc.), consult \`load_skill({ skillId: "helmx-cli", path: "references/skill-and-plugin-dev.md" })\` on demand.

### 3. Mandatory static self-check (Zero-Broken-App)

After writing or modifying code you **must** run:

\`\`\`bash
helmx plugins doctor <absDir> --json
\`\`\`

Verify BOTH conditions in the JSON output:
1. \`ok === true\` (zero failed checks across \`manifest\` -> \`backend\` -> \`register\` -> \`client\`);
2. \`screens\` is non-empty (e.g. \`["main"]\` -- confirming at least one \`ctx.ui.screen\` registered cleanly).

- When \`ok: false\` or \`screens\` is empty, fix every failing item on the spot (TS types, schemas, missing \`ctx.ui.screen\`, or React export mismatches) and re-run \`helmx plugins doctor <absDir> --json\` until passing;
- **Never skip doctor and deliver anyway**; never fabricate check results.

### 4. Install / hot-update or deliver as draft

- **Install or upgrade immediately** (when the user wants it usable right away or wants to iterate on an existing app):
  \`\`\`bash
  helmx plugins install <absDir> --enable --json
  \`\`\`
  - First install copies the plugin into the Hub's managed plugin directory, registers it, and enables it.
  - **Idempotent local-directory hot update**: re-running \`helmx plugins install <absDir> --enable\` (or \`helmx plugins install <absDir>\`) from the **same canonical local source directory** atomically hot-updates the installed plugin in place, **preserves existing \`ctx.doc\` data**, and ensures it is enabled. (Installing a *different* source directory with the same plugin ID is honestly rejected with \`409 plugin_package_already_installed\`.)
  - Verify the installed summary reports \`enabled: true\` and \`enableError\` is absent.
  - On success, if \`generative-ui\` is available you may output a \`\`\`ui delivery card with "Open side-by-side in right split" (\`{ "type": "helmx:open", "target": "screen:<appId>/main", "split": true }\`) and "Open in Plugin Center" (\`{ "type": "helmx:open", "target": "plugins:<appId>" }\`) buttons; otherwise give the user clear navigation instructions (Plugin Center -> **With views** -> **Open view**).
- **Review first (draft mode)**: when the user asks to inspect the code before installing, stop after \`helmx plugins doctor <absDir> --json\` passes, summarize the plugin's docs/actions/screens and source directory, and tell the user they can install it via \`helmx plugins install <absDir> --enable\` or Plugin Center -> **Install plugin**.
- **Uninstall**: \`helmx plugins remove <appId> --yes\` (deletes the Hub's managed copy and persisted docs; local workspace source directory is untouched).

## Boundary facts (tell the user honestly)

- **No sandbox**: installed plugins are in-process trusted code running inside the Hub with full host privileges (they can read/write files and execute across nodes); only install code from trusted sources;
- **Path boundary**: \`helmx plugins doctor <absDir>\` and \`helmx plugins install <absDir>\` resolve local directories on the **Hub host filesystem** (local node), not on a remote node; when a conversation runs on a remote node, state this boundary honestly rather than guessing a Hub path;
- **Managed copy, not symlink**: \`helmx plugins install <absDir>\` copies source files into \`<dataDir>/installed-plugins/<appId>\`. After editing the workspace source, re-run \`helmx plugins install <absDir> --enable\` (or \`helmx plugins update <appId>\`) to sync changes.
`

const APP_BUILDER_FULLSTACK_TEMPLATE = `# Minimal Runnable Full-Stack Micro-App Template

Start directly from this template; just replace the id, copy, and data structures. The template passes every \`helmx plugins doctor <dir> --json\` checkpoint (4 stages: manifest / backend / register / client, with non-empty \`screens: ["main"]\`) and installs directly via \`helmx plugins install <dir> --enable\`. Faster path: run \`helmx plugins init <name> --dir <parentDir> --template app\` to scaffold the exact same shape locally.

## Directory

\`\`\`
apps/sample-desk/
  plugin.json
  index.ts
  client/index.tsx
\`\`\`

## plugin.json

\`\`\`json
{ "id": "sample-desk", "name": "Sample Desk", "main": "index.ts", "clientRoot": "./client", "version": "0.1.0" }
\`\`\`

## index.ts (backend)

\`\`\`ts
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
\`\`\`

## client/index.tsx (frontend: HIG-compliant \`@helmx/plugin-client\` primitives; zero private stylesheet)

\`\`\`tsx
import { useMemo, useState, type ReactNode } from 'react'
import type { ScreenProps } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  Checkbox,
  DetailDrawer,
  EmptyState,
  Field,
  Input,
  List,
  ListRow,
  LoadingState,
  Screen,
  ScreenToolbar,
  SearchBox,
  Stack,
  TabCount,
  Tabs,
  TabsList,
  TabsTrigger,
  formatTime,
  usePluginAction,
  usePluginContext,
  usePluginDoc,
  useScreenDrawer,
} from '@helmx/plugin-client'

interface Item { id: string; title: string; done: boolean; createdAt: number }

export function MainScreen(props: Partial<ScreenProps>): ReactNode {
  const { notify } = usePluginContext()
  const doc = usePluginDoc<{ list: Item[] }>('items')
  const actions = usePluginAction()
  const drawer = useScreenDrawer({ createParam: 'create', scope: props })
  const [filter, setFilter] = useState<'all' | 'open' | 'done'>('all')
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')

  const list = doc?.list ?? []
  const doneCount = list.filter((it) => it.done).length
  const openCount = list.length - doneCount
  const visible = useMemo(
    () =>
      list.filter((it) => {
        if (filter === 'open' && it.done) return false
        if (filter === 'done' && !it.done) return false
        if (query.trim() === '') return true
        return it.title.toLowerCase().includes(query.trim().toLowerCase())
      }),
    [list, filter, query],
  )

  const handleAdd = async (): Promise<void> => {
    const title = draft.trim()
    if (title === '') return
    await actions.run('add_item', { title }, {
      key: 'add-item',
      onSuccess: () => {
        setDraft('')
        drawer.close()
      },
      onError: (msg) => notify('Add failed: ' + msg, 'error'),
    })
  }

  const handleResetFilters = (): void => {
    setFilter('all')
    setQuery('')
  }

  const handleToggle = (item: Item, checked: boolean): void => {
    void actions.run('set_done', { id: item.id, done: checked }, {
      key: 'toggle:' + item.id,
      onError: (msg) => notify('Update failed: ' + msg, 'error'),
    })
  }

  return (
    <Screen
      layout="contained"
      title="Sample Desk"
      subtitle={'Done ' + doneCount + ' / ' + list.length}
      actions={
        <Button
          variant="primary"
          size="sm"
          icon="plus"
          disabled={actions.pending}
          onClick={() => drawer.openCreate()}
        >
          <span className="pane-action-label">New Item</span>
        </Button>
      }
      toolbar={
        <ScreenToolbar
          label="Item filters"
          actions={
            <SearchBox
              variant="toolbar"
              size="sm"
              value={query}
              onChange={setQuery}
              placeholder="Filter items..."
              ariaLabel="Filter items"
            />
          }
        >
          <Tabs
            value={filter}
            onValueChange={(next) => setFilter(next as 'all' | 'open' | 'done')}
            variant="pills"
            size="sm"
          >
            <TabsList aria-label="Status filter">
              <TabsTrigger value="all">
                <span>All</span>
                <TabCount>{list.length}</TabCount>
              </TabsTrigger>
              <TabsTrigger value="open">
                <span>Open</span>
                <TabCount>{openCount}</TabCount>
              </TabsTrigger>
              <TabsTrigger value="done">
                <span>Done</span>
                <TabCount>{doneCount}</TabCount>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </ScreenToolbar>
      }
    >
      {doc === undefined ? (
        <LoadingState label="Loading items..." />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={list.length === 0 ? 'list-checks' : 'search'}
          title={list.length === 0 ? 'No items yet' : 'No matching items'}
          action={
            list.length === 0 ? (
              <Button variant="primary" size="sm" icon="plus" onClick={() => drawer.openCreate()}>
                New Item
              </Button>
            ) : (
              <Button variant="secondary" size="sm" icon="rotate-ccw" onClick={handleResetFilters}>
                Reset Filters
              </Button>
            )
          }
        />
      ) : (
        <List label="Item list">
          {visible.map((it) => (
            <ListRow
              key={it.id}
              interactive={false}
              leading={
                <Checkbox
                  checked={it.done}
                  aria-label={'Mark ' + it.title + (it.done ? ' open' : ' done')}
                  onChange={(checked) => handleToggle(it, checked)}
                />
              }
              title={it.title}
              meta={<span className="mono text-muted">{formatTime(it.createdAt)}</span>}
              trailing={<Badge tone={it.done ? 'ok' : 'neutral'}>{it.done ? 'Done' : 'Open'}</Badge>}
            />
          ))}
        </List>
      )}

      <DetailDrawer
        {...drawer.drawerProps}
        title="New Item"
        footer={
          <>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" disabled={actions.pending} onClick={() => drawer.close()}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon="check"
              pending={actions.pendingKey === 'add-item'}
              disabled={draft.trim() === ''}
              onClick={() => void handleAdd()}
            >
              Add Item
            </Button>
          </>
        }
      >
        <Stack gap="md">
          <Field label="Item title" required>
            <Input
              value={draft}
              placeholder="Type a todo and press Enter..."
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => (e.key === 'Enter' ? void handleAdd() : undefined)}
            />
          </Field>
        </Stack>
      </DetailDrawer>
    </Screen>
  )
}
\`\`\`

## Verify and install

\`\`\`bash
helmx plugins doctor /abs/path/to/apps/sample-desk --json   # check ok: true and screens: ["main"]
helmx plugins install /abs/path/to/apps/sample-desk --enable --json
\`\`\`

After editing source files, re-run \`helmx plugins doctor\` and \`helmx plugins install /abs/path/to/apps/sample-desk --enable\` to hot-update in place while preserving existing \`ctx.doc\` data.

## Styling rules

- Read \`load_skill({ skillId: "helmx-cli", path: "references/ui-hig.md" })\` before authoring UI.
- Default to zero private CSS: compose layout and controls exclusively with SDK primitives (\`Screen\` with \`toolbar\` and \`actions\`, \`ScreenToolbar\`, \`List\` / \`ListRow\`, \`Card\` / \`CardGrid\` / \`SelectCard\`, \`DataTable\`, \`KvGrid\`, \`DetailDrawer\`, \`ModalDialog\`, \`DropdownMenuItem\`, \`Kbd\`, \`Field\`, \`Input\`, 5-variant \`Button\` without \`variant="default"\`, \`SearchBox\` with \`surface="default|subtle|frameless"\`, \`Tabs\` + \`TabCount\`, \`EmptyState\`, \`LoadingState\`); never re-declare raw \`.btn*\` / \`.input*\` / \`.section-flat\` / \`.form-grid\` / \`.kv-list\` / \`.card\` / \`.tabs-bar\` / \`.tab-btn\` / \`.modal-header\` / \`.modal-footer\` / \`.dropdown-panel\` / \`.kbd-hint\` classes on intrinsic HTML tags or use native \`<select>\` / \`<input type="search">\`.
- Add a scoped custom stylesheet only when the host vocabulary is genuinely insufficient, keep every \`:hover\` inside \`@media (hover: hover)\`, and style strictly with host CSS variables (\`var(--fg)\`, \`var(--border)\`, ...).

## Checklist cross-reference

- \`index.ts\` (and \`plugin.json\`) declares \`clientRoot: './client'\` explicitly (when undeclared the default root is the plugin directory itself, and \`client/index.tsx\` cannot be found);
- Backend \`ctx.doc('items', ..., { public: true })\` + \`flush()\` after writes;
- \`ctx.action\` declares both \`inputSchema\` and \`outputSchema\` (the single-point Schema contract; missing ones are rejected at register), with \`exposeAsTool: true\`;
- The frontend follows \`helmx-cli\` \`references/ui-hig.md\`: single \`<Screen toolbar={<ScreenToolbar />}>\` shell, \`List\` / \`ListRow\` for item rosters, \`DetailDrawer\` + \`useScreenDrawer\` for create/edit drawers, 5-variant \`Button\` (default \`secondary\`, zero \`variant="default"\`), \`SearchBox(variant="toolbar", size="sm")\`, \`Checkbox\` with \`onChange(checked)\`, and notifications via \`notify(message, tone)\`, without introducing undeclared bare npm packages;
- Zero private stylesheet by default; if scoped CSS is added, gate every \`:hover\` inside \`@media (hover: hover)\` and use host semantic tokens;
- \`ctx.ui.screen({ id: 'main', client: { module: 'index.tsx', export: 'MainScreen' } })\` and the frontend really exports \`MainScreen\` (\`helmx plugins doctor\` reports \`screens: ["main"]\`);
- No \`sidebarItem\` registered by default (avoiding sidebar bloat; the optional sidebar entry in the \`helmx plugins init --template app\` skeleton can be removed as needed); zero Emoji; styling uses host CSS variables.
`

const appBuilderSkillVars: Record<string, string> = {
  SKILL_ID: APP_BUILDER_SKILL_ID,
  MANAGED_BY: APP_BUILDER_SKILL_OWNER,
}

export const APP_BUILDER_SKILL_MD: string = renderSkillTemplate(
  APP_BUILDER_SKILL_TEMPLATE,
  appBuilderSkillVars,
)

export const APP_BUILDER_FULLSTACK_TEMPLATE_MD: string = renderSkillTemplate(
  APP_BUILDER_FULLSTACK_TEMPLATE,
  appBuilderSkillVars,
)

export const APP_BUILDER_SKILL_ASSET: BuiltinSkillAsset = {
  id: APP_BUILDER_SKILL_ID,
  skillMd: APP_BUILDER_SKILL_MD,
  references: {
    'fullstack-template.md': APP_BUILDER_FULLSTACK_TEMPLATE_MD,
  },
}
