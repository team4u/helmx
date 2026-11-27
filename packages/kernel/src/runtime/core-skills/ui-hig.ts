/**
 * Single-source Helmx UI Human Interface Guidelines (HIG) embedded into the
 * kernel-owned `helmx-cli` managed skill (`references/ui-hig.md`).
 *
 * Canonical source of truth lives in `.helmx/skills/helmx-ui/SKILL.md` (body)
 * and `.helmx/skills/helmx-ui/references/patterns.md`. Byte-for-byte parity
 * is enforced by `packages/kernel/test/services.test.ts`.
 *
 * Stored as a compiled TypeScript module inside `@helmx/kernel` so `tsc -b`,
 * incremental `pruneDist`, and `@helmx/payload` (`kernel.tgz`) ship the asset
 * uniformly across dev and dist with zero runtime repo-path lookups.
 */

export const HELMX_UI_HIG_BODY_MD = `# Helmx UI Human Interface Guidelines (HIG)

## Core Principle: Diverse Domain Patterns, One Unified Shell and Atom Kit

> **Diverse list and stage patterns by domain; single unified shell, atoms, and interaction grammar across core and plugins.**
> （模式随业务多元，外壳与原子零件全站唯一。）

Core \`@helmx/web\` views (Five System Centers, Conversation Overview, workbench, modals) and all plugins (built-in and external micro-apps) share **100% of the same \`@helmx/plugin-client\` primitives, geometry tokens, and interaction grammar**. Never create parallel page shells, legacy aliases, or per-page form/button restyles.

## 1. Quiet Surface Visual Principles

- **Paper-neutral surfaces and hairline structure**: Build hierarchy with semantic surface tokens (\`--bg\`, \`--bg-elevated\`, \`--bg-subtle\`, \`--bg-muted\`) and \`1px\` hairlines (\`--border\`, \`--line-2\`), not heavy drop shadows or saturated fills.
- **Restrained color semantics**: Reserve \`--accent\`, \`--ok\`, \`--warn\`, and \`--err\` (plus their \`*-bg\` / \`*-border\` pairs) for focal actions and honest status signals. Always style via host CSS tokens so light and dark themes stay balanced—never hardcode hex colors.
- **Numeric and technical typography**: Use \`tabular-nums\` on counts, durations, quotas, and timestamps; use monospace (\`mono\` / \`--font-mono\`) for IDs, model keys, paths, ports, and cron expressions.
- **Zero Emoji iron rule**: Never put Emoji anywhere in UI copy, titles, navigation, buttons, badges, or cards. Use plain text and \`lucide-react\` vector icons via \`<HelmxIcon>\`.

## 2. Control Scale (32 / 28 / 22px Parity)

All interactive controls share three locked height tiers defined in \`tokens.css\`. Controls placed side-by-side in the same row MUST use the same tier for exact pixel-height alignment.

| Tier | Height Token | Radius Token | Font / Icon | Primary Placement | Exact Height-Parity Controls |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **\`md\`** | \`--control-h-md: 32px\` | \`--control-radius-md\` (\`--radius-sm\`, 7px) | \`--control-font-md: 13px\` / 14px | Drawer and modal form fields, standalone input rows, dialog footers | \`Button\`, \`IconButton\`, \`Input\`, \`Select\`, \`MultiSelect\`, \`SearchBox\`, \`SegmentedControl\`, \`ModelPickerControl(variant="field")\` |
| **\`sm\`** | \`--control-h-sm: 28px\` | \`--control-radius-sm\` (\`--radius-xs\`, 5px) | \`--control-font-sm: 12px\` / 13px | **Topbar actions, \`ScreenToolbar\`, narrow panels, list/card inline controls** | All controls above + \`Tabs(variant="pills")\` (radius \`999px\`) |
| **\`xs\`** | \`--control-h-xs: 22px\` | \`--control-radius-xs\` (\`--radius-xs\`, 5px) | \`--control-font-xs: 11px\` / 12px | List/table trailing micro-buttons, tool trace actions, inline copy/clear | \`Button\`, \`IconButton\` (\`Badge\` is a fixed 20px read-only tag) |

## 3. Base Controls Contract

### 5-Variant \`Button\` and \`IconButton\`

The ambiguous \`'default'\` variant is **removed**—never write \`variant="default"\`. \`Button\` defaults to \`variant="secondary"\`, \`size="md"\`; \`IconButton\` defaults to \`variant="ghost"\`, \`size="md"\`.

| Variant | Role | Hard Rules |
| :--- | :--- | :--- |
| **\`secondary\`** | Standard actions (Refresh, Export, Import, Save template, Cancel) | Default \`Button\` variant; white surface + \`1px\` border. |
| **\`primary\`** | Single primary create or submit action | **At most 1 \`primary\` per visual focus zone** (topbar actions, empty state, drawer footer, modal footer); always rightmost (immediately before the split toggle in topbars). |
| **\`ghost\`** | Row-trailing icons, close buttons, subtle cancel | Default \`IconButton\` variant; borderless transparent. |
| **\`danger\`** | Destructive delete/remove/reset actions | Irreversible actions MUST be gated by \`<ConfirmDialog danger ... />\`. |
| **\`inline\`** | Inline expand, retry, jump micro-actions | Borderless compact text action. |

- **Async actions**: Always pass \`pending\` (pairs cleanly with \`usePluginAction\`).
- **Icon-only buttons**: Always use \`<IconButton>\` with a non-empty \`label\` (or \`aria-label\`)—never an unlabeled \`<Button>\`.
- **Responsive topbar labels**: Wrap topbar action labels in \`<span className="pane-action-label">\` so narrow panes collapse cleanly to centered icons with zero ghost gap.

### \`SearchBox\`, \`Input\`, and \`ModelPickerControl\`

- **\`SearchBox\`**: Accepts \`variant?: 'default' | 'toolbar'\` and \`size?: 'sm' | 'md'\` (default \`'md'\`). In toolbars, always use \`<SearchBox variant="toolbar" size="sm" value={...} onChange={...} />\` (\`28px\` height, \`200–260px\` adaptive on the right, auto-expands to \`100%\` at \`<= 680px\` \`@container\`/\`@media\`, single clear button, built-in \`Esc\` clear-then-blur inside \`ScreenToolbar\`). **Never use \`<input type="search">\`**.
- **\`Input\`**: Supports \`size?: 'sm' | 'md'\`, \`prefix?: ReactNode\` (e.g. \`prefix="tier/"\`), \`suffix?: ReactNode\` (e.g. \`suffix="s"\`), \`inputClassName?: string\`, \`mono\`, and \`invalid\`. The outer \`.helmx-input-wrap\` carries the border and \`:focus-within\` ring with full \`FieldContext\` wiring—never build ad-hoc prefix wrapper divs.
- **\`ModelPickerControl\`**: Supports \`variant?: 'composer' | 'field'\` (default \`'composer'\`), \`size?: 'sm' | 'md'\` (default \`'md'\`), \`invalid?: boolean\`, and \`className?: string\`. Use \`variant="field"\` inside all forms and drawers (\`32px\`/\`28px\` bordered trigger matching \`Select\`, defaults \`popoverSide="bottom"\`, auto-connects to enclosing \`<Field>\`). Never restyle \`.composer-model-button\` locally.

### 4-Way Selector Decision Table

| Scenario | Required Primitive | Hard Rules |
| :--- | :--- | :--- |
| **2–4 mutually exclusive sub-views or modes** | \`SegmentedControl(size="sm")\` or \`Tabs(variant="segmented", size="sm")\` | Keep labels short; place on the left of \`ScreenToolbar\`. |
| **Status/category filters with live counts** | \`Tabs(variant="pills", size="sm")\` + \`<TabCount>\` (or \`Tabs.Count\`) | Uses borderless soft \`--bg-muted\` active fill + inline \`tabular-nums\` count; never nest bordered \`<Badge>\` inside triggers. |
| **5+ options or dynamic resources (nodes, profiles, scopes)** | Radix \`Select\` / \`MultiSelect\` (\`searchable\` for long lists) | **Native \`<select>\` is strictly forbidden repo-wide.** |
| **Boolean state** | \`Switch\` (immediate effect) or \`Checkbox\` (deferred submit / batch selection) | Pair with \`<Field htmlFor={false}>\` when rendering a self-labeled control or multi-control group. |

## 4. Stage and List Archetypes (5 First-Class + Domain-Extensible)

Choose the stage/list layout that best serves the domain's information model. **Hairline Roster List is NOT the only permitted list layout.**

| Archetype | Shared SDK / Shell Primitive | Best Fit | Structure & Guardrails |
| :--- | :--- | :--- | :--- |
| **1. Hairline Roster List** | \`<List density="default\\|compact">\` + \`<ListRow>\` | Rules, configs, port mappings, scheduled triggers, workflow libraries, run histories, templates, narrow-panel item lists | \`1px\` bordered container + hairline dividers; sibling-slot a11y (\`<button aria-pressed>\` main trigger + always-visible \`trailing\` + hover/focus-revealed \`actions\` inside \`@media (hover: hover)\`, always visible on touch); collapses to single column at \`@container (max-width: 680px)\` and \`@media (max-width: 680px)\`. |
| **2. Object Card Grid** | \`<CardGrid minWidth="sm\\|md\\|lg">\` + \`<SelectCard>\` | Browsable asset and marketplace catalogs (Profiles, Model Providers, Plugins/Core Capabilities, Skills, Nodes) | Built-in \`32x32\` rounded \`icon\` box (string resolves via \`HelmxIcon\`), inline \`badges\`, 2-line clamped \`description\`, sibling \`actions\` and \`footer\`. Zero per-page card CSS clones. |
| **3. Grouped Triage Stage** | \`<Screen toolbar>\` + collapsible domain sections + SDK controls | Multi-dimension operational boards (exemplar: \`ConversationOverview\`) with status/dimension groups, bulk governance, and aggregate cards with sub-chips | Uses the unified \`<Screen toolbar>\` shell, \`sm (28px)\` filter controls, \`sp.*\` URL params, and SDK buttons/menus/badges. |
| **4. Structured Data Table** | \`<DataTable loading empty columns label>\` | **Only** multi-column horizontal numeric comparison and aligned scanning (quota matrices, ledgers, billing reports) | \`--bg-subtle\` header, \`tabular-nums\` numbers. **Hard rule**: narrow panels/drawers (\`< 560px\`) MUST NEVER exceed 3 columns—use \`<List>\` instead. |
| **5. Master-Detail / Full-Bleed Canvas** | \`<Screen layout="full-bleed">\` | Side-by-side Diff inspectors (\`builtin:changes\`), DAG/topology canvases, zoomable diagrams (\`builtin:mermaid\`), custom multi-pane workbenches | Edge-to-edge stage below the unified 46px topbar and optional sticky \`toolbar\`. |

**New domain-specific patterns are explicitly welcome**: when none of the 5 archetypes fits (e.g., Kanban lanes, calendar matrix, waterfall trace), design a domain-native stage while composing exclusively from the unified \`<Screen>\` topbar/toolbar/drawer shell, \`32/28/22px\` SDK controls, semantic tokens, and standard interaction grammar.

## 5. Single Unified Page Shell and 4 Container Densities

Core System Centers, Conversation Overview, and Plugin Screens share ONE \`<Screen>\` shell:

\`\`\`text
+------------------------------------------------------------------------------+
| 1. 46px Topbar (.pane-topbar — shared by Core Views & ScreenHost)            |
|    [Icon] Title              [Secondary(sm)] [+ Primary(sm)] [Split Toggle]  |
+------------------------------------------------------------------------------+
| 2. Sticky Single-Layer Toolbar (<Screen toolbar={<ScreenToolbar />}>)        |
|    Left:  View Switch (Segmented) / Scope (Select) / Category (Pills+Count)  |
|    Right: Auxiliary Filters + SearchBox(variant="toolbar", size="sm")        |
+------------------------------------------------------------------------------+
| 3. Single Scroll Stage (.screen-host-body -> .screen-container)              |
|    contained (default centered max-width) | full-bleed (edge-to-edge canvas) |
+------------------------------------------------------------------------------+
\`\`\`

- **Locked single-layer toolbar**: Always **switch/filter on the left, search on the right** (\`<ScreenToolbar actions={<SearchBox ... />}>\` or flex-aligned right cluster). Never stack an underline tab row above a second toolbar, and never put Create/Primary actions inside \`ScreenToolbar\`—view-level actions belong in \`<Screen actions={...}>\`.
- **Host bridge props**: \`<Screen>\` provides \`toolbar\`, \`topbar\`, \`icon\`, \`topbarEnd\`, \`banner\`, \`overlays\`, \`dataView\`, \`contentClassName\`, \`bodyId\`, and \`bodyRole\` so host views use the exact same shell without parallel wrappers.

### 4 Container Density Boundaries

1. **Full-Screen Stage (\`Screen\`)**: Topbar and toolbar locked to \`sm (28px)\`. Selecting or creating an item opens a right-side \`<DetailDrawer>\` (\`520–560px\` desktop, \`100vw\` at \`<= 680px\`) paired with \`useScreenDrawer\` for URL-hash and browser/mobile Back sync. Drawer forms use \`md (32px)\` fields, \`Cmd/Ctrl + Enter\` submit, dirty-state gating on edit, and a sticky footer: left \`danger\` delete (edit mode) + \`<div className="flex-1" />\` + \`ghost\` cancel + rightmost \`primary\` save.
2. **Narrow Side Panels (\`workbenchPanel\`, \`settingsPanel\`, drawer \`slot\`, \`360–520px\`)**: Use \`sm (28px)\` and \`xs (22px)\` controls only. Never render multi-column \`<CardGrid>\` or \`> 3\`-column \`<DataTable>\`; compose with \`<KvGrid>\`, \`<List density="compact">\`, and single-column \`<Card variant="subtle">\`. Never repeat a redundant top-level screen title.
3. **Timeline Inline Blocks (\`toolView\`, \`timelineRenderer\`, \`json-render\`)**: Follow Quiet Surface \`26px\` single-line traces with left chevron at \`x=8px\` (\`6px\` in \`<= 450px\` panes). Keep inline cards compact; on \`replaceRow\` cards, let the host IO panel handle input/output disclosure instead of rendering duplicate \`ToolCallDetails\`.
4. **Centered Modals (\`Dialog\` / \`ConfirmDialog\`)**: Width \`440–560px\`. Strictly limited to destructive confirmation, short forms (\`<= 4\` fields, e.g., Save Template or Install Plugin), single-credential entry, and media preview. Never cram catalogs, multi-dimensional search, or management lists into a modal.

## 6. Creative Zone Boundaries and CSS Hygiene

- **Where to express domain craft**: Inside \`<Screen layout="full-bleed">\` canvases (Diff viewers, DAGs, zoomable diagrams, charts) and domain micro-visuals inside cards or \`ListRow\` slots (\`meta\`, \`leading\`, \`trailing\`).
- **Zero private CSS by default**: Compose with SDK primitives and host tokens (\`--space-1..6\`, \`--bg-*\`, \`--fg-*\`, \`--border\`, \`--radius-*\`). Add a local \`styles.css\` only when host primitives do not cover a domain structure. Never copy host button/input/table/card CSS or edit \`packages/web/src/styles.css\` from a plugin.
- **Mandatory \`:hover\` gate**: Every \`:hover\` rule MUST sit inside \`@media (hover: hover)\` (enforced by \`pnpm check:hygiene\`). Any hover-revealed control MUST remain visible under \`@media (hover: none)\` or via \`:focus-within\`.
- **No bulk inline styles**: Avoid \`style\` objects except dynamic coordinates/dimensions; use SDK primitives (\`Stack\`, \`Card\`, \`List\`, \`KvGrid\`, \`Field\`) and tokens.

## 7. Pre-Delivery Checklist

- [ ] **Zero Emoji** across all UI copy, titles, icons, badges, and empty states.
- [ ] **Zero \`variant="default"\`** on \`Button\`/\`IconButton\`; at most **1 \`primary\`** per focus zone, placed rightmost.
- [ ] **Zero native \`<select>\`** and **zero \`<input type="search">\`**; zero hand-rolled absolute-positioned popovers or modals.
- [ ] **Exact height parity**: \`md (32px)\` in drawer/modal forms, \`sm (28px)\` in topbars/toolbars/narrow panels, \`xs (22px)\` for row micro-actions.
- [ ] **Single-layer \`<Screen toolbar={<ScreenToolbar />}>\`**: left switch/filter, right \`SearchBox(variant="toolbar", size="sm")\`; view-level Create/Refresh in \`<Screen actions>\` with \`<span className="pane-action-label">\`.
- [ ] **Right-side \`DetailDrawer\` + \`useScreenDrawer\`** for deep item inspection/editing; \`ConfirmDialog(danger)\` for irreversible deletes; \`< 560px\` panels have no \`CardGrid\` and \`<= 3\` \`DataTable\` columns.
- [ ] **CSS & runtime hygiene**: all \`:hover\` inside \`@media (hover: hover)\`, light + dark semantic tokens only, Fast Refresh compliant (\`.tsx\` exports components and types only), SSR \`renderToString\` safe.
- [ ] **Verification**: run \`helmx plugins doctor <dir> --json\` (external plugins) or \`pnpm verify\` / relevant unit & browser checks (in-repo).

> Canonical copy-pasteable JSX recipes: see \`references/patterns.md\` (when reading \`.helmx/skills/helmx-ui\`) or the **Canonical JSX Patterns** section below (when reading \`helmx-cli\` \`references/ui-hig.md\`).
`

export const HELMX_UI_HIG_PATTERNS_MD = `# Canonical JSX Patterns (Helmx UI HIG)

All recipes below compile against \`@helmx/plugin-client\` with zero private stylesheet, zero \`variant="default"\`, zero Emoji, and full SSR (\`renderToString\`) and Fast Refresh compliance.

## 1. Management Screen with Hairline Roster List

Use for rules, port mappings, scheduled triggers, workflow libraries, run logs, templates, and tier rosters.

\`\`\`tsx
import { useMemo, useState, type ReactNode } from 'react'
import type { ScreenProps } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  List,
  ListRow,
  LoadingState,
  Screen,
  ScreenToolbar,
  SearchBox,
  SegmentedControl,
  StatusLight,
  TabCount,
  Tabs,
  TabsList,
  TabsTrigger,
  usePluginAction,
  usePluginContext,
  usePluginDoc,
  useScreenDrawer,
} from '@helmx/plugin-client'

interface RuleItem {
  id: string
  name: string
  kind: 'cron' | 'webhook'
  schedule: string
  description?: string
  enabled: boolean
}

export function RulesManagerScreen(props: Partial<ScreenProps>): ReactNode {
  const ctx = usePluginContext()
  const doc = usePluginDoc<{ rules: RuleItem[] }>('state')
  const actions = usePluginAction()
  const drawer = useScreenDrawer({ param: 'edit', createParam: 'create', scope: props })

  const [view, setView] = useState<'rules' | 'history'>('rules')
  const [kind, setKind] = useState<'all' | 'cron' | 'webhook'>('all')
  const [query, setQuery] = useState('')
  const [pendingDelete, setPendingDelete] = useState<RuleItem | null>(null)

  const rules = doc?.rules ?? []
  const filtered = useMemo(
    () =>
      rules.filter((item) => {
        if (kind !== 'all' && item.kind !== kind) return false
        if (query.trim() === '') return true
        const q = query.trim().toLowerCase()
        return item.name.toLowerCase().includes(q) || item.schedule.toLowerCase().includes(q)
      }),
    [rules, kind, query],
  )

  const resetFilters = (): void => {
    setKind('all')
    setQuery('')
  }

  const handleConfirmDelete = (): void => {
    if (pendingDelete === null) return
    const target = pendingDelete
    setPendingDelete(null)
    void actions.run('delete_rule', { id: target.id }, {
      key: \`delete:\${target.id}\`,
      onSuccess: () => ctx.notify(\`Deleted \${target.name}\`),
    })
  }

  const handleDeleteOpenChange = (open: boolean): void => {
    if (!open) setPendingDelete(null)
  }

  return (
    <Screen
      layout="contained"
      title="Automation Rules"
      actions={
        <>
          <Button
            variant="secondary"
            size="sm"
            icon="refresh-cw"
            pending={actions.pendingKey === 'refresh'}
            onClick={() => void actions.run('refresh', {}, { key: 'refresh' })}
          >
            <span className="pane-action-label">Refresh</span>
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon="plus"
            disabled={actions.pending}
            onClick={() => drawer.openCreate()}
          >
            <span className="pane-action-label">New Rule</span>
          </Button>
        </>
      }
      toolbar={
        <ScreenToolbar
          label="Rule filters"
          actions={
            <SearchBox
              variant="toolbar"
              size="sm"
              value={query}
              onChange={setQuery}
              placeholder="Filter rules..."
              ariaLabel="Filter rules"
            />
          }
        >
          <SegmentedControl
            size="sm"
            aria-label="View mode"
            value={view}
            onValueChange={(next) => setView(next === 'history' ? 'history' : 'rules')}
            items={[
              { value: 'rules', label: 'Rules' },
              { value: 'history', label: 'History' },
            ]}
          />
          {view === 'rules' && (
            <Tabs
              value={kind}
              onValueChange={(next) => setKind(next as 'all' | 'cron' | 'webhook')}
              variant="pills"
              size="sm"
            >
              <TabsList aria-label="Rule kind">
                <TabsTrigger value="all">
                  <span>All</span>
                  <TabCount>{rules.length}</TabCount>
                </TabsTrigger>
                <TabsTrigger value="cron">
                  <span>Cron</span>
                  <TabCount>{rules.filter((r) => r.kind === 'cron').length}</TabCount>
                </TabsTrigger>
                <TabsTrigger value="webhook">
                  <span>Webhook</span>
                  <TabCount>{rules.filter((r) => r.kind === 'webhook').length}</TabCount>
                </TabsTrigger>
              </TabsList>
            </Tabs>
          )}
        </ScreenToolbar>
      }
    >
      {doc === undefined ? (
        <LoadingState label="Loading rules..." />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={rules.length === 0 ? 'zap' : 'search'}
          title={rules.length === 0 ? 'No rules yet' : 'No matching rules'}
          hint={rules.length === 0 ? 'Create a cron or webhook rule to get started.' : undefined}
          hintSubtle
          action={
            rules.length === 0 ? (
              <Button variant="primary" size="sm" icon="plus" onClick={() => drawer.openCreate()}>
                New Rule
              </Button>
            ) : (
              <Button variant="secondary" size="sm" icon="rotate-ccw" onClick={resetFilters}>
                Reset Filters
              </Button>
            )
          }
        />
      ) : (
        <List label="Automation rules">
          {filtered.map((item) => (
            <ListRow
              key={item.id}
              selected={drawer.itemId === item.id}
              tone={item.enabled ? 'default' : 'warn'}
              leading={<StatusLight tone={item.enabled ? 'done' : 'blocked'} label={item.enabled ? 'Active' : 'Paused'} />}
              title={<span className="mono">{item.name}</span>}
              meta={<code className="mono">{item.schedule}</code>}
              description={item.description}
              trailing={<Badge tone={item.enabled ? 'ok' : 'neutral'}>{item.kind}</Badge>}
              actions={
                <IconButton
                  icon="trash-2"
                  size="xs"
                  variant="ghost"
                  label={\`Delete \${item.name}\`}
                  pending={actions.pendingKey === \`delete:\${item.id}\`}
                  onClick={() => setPendingDelete(item)}
                />
              }
              onSelect={() => drawer.openItem(item.id)}
            />
          ))}
        </List>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={handleDeleteOpenChange}
        title="Delete rule"
        description={pendingDelete ? \`Delete "\${pendingDelete.name}"? This cannot be undone.\` : ''}
        confirmText="Delete"
        cancelText="Cancel"
        danger
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </Screen>
  )
}
\`\`\`

## 2. Catalog Screen with Object Card Grid

Use for browsable asset or marketplace catalogs (Profiles, Model Providers, Plugins, Skills, Nodes) that benefit from a \`32x32\` icon box, inline badges, and a 2-line clamped description.

\`\`\`tsx
import { useMemo, useState, type ReactNode } from 'react'
import {
  Badge,
  Button,
  CardGrid,
  EmptyState,
  Screen,
  ScreenToolbar,
  SearchBox,
  Select,
  SelectCard,
  TabCount,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@helmx/plugin-client'

interface CatalogEntry {
  id: string
  name: string
  category: 'core' | 'community'
  scope: string
  icon: string
  description: string
  enabled: boolean
}

interface CatalogScreenProps {
  entries: ReadonlyArray<CatalogEntry>
  selectedId?: string
  onSelect: (id: string) => void
  onInstall: () => void
}

export function CatalogScreen({ entries, selectedId, onSelect, onInstall }: CatalogScreenProps): ReactNode {
  const [category, setCategory] = useState<'all' | 'core' | 'community'>('all')
  const [scope, setScope] = useState('all')
  const [query, setQuery] = useState('')

  const visible = useMemo(
    () =>
      entries.filter((entry) => {
        if (category !== 'all' && entry.category !== category) return false
        if (scope !== 'all' && entry.scope !== scope) return false
        if (query.trim() === '') return true
        const q = query.trim().toLowerCase()
        return entry.name.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q)
      }),
    [entries, category, scope, query],
  )

  return (
    <Screen
      layout="contained"
      title="Extensions"
      actions={
        <Button variant="primary" size="sm" icon="plus" onClick={onInstall}>
          <span className="pane-action-label">Install</span>
        </Button>
      }
      toolbar={
        <ScreenToolbar
          label="Extension filters"
          actions={
            <SearchBox
              variant="toolbar"
              size="sm"
              value={query}
              onChange={setQuery}
              placeholder="Search extensions..."
              ariaLabel="Search extensions"
            />
          }
        >
          <Tabs
            value={category}
            onValueChange={(next) => setCategory(next as 'all' | 'core' | 'community')}
            variant="pills"
            size="sm"
          >
            <TabsList aria-label="Category">
              <TabsTrigger value="all">
                <span>All</span>
                <TabCount>{entries.length}</TabCount>
              </TabsTrigger>
              <TabsTrigger value="core">
                <span>Core</span>
                <TabCount>{entries.filter((e) => e.category === 'core').length}</TabCount>
              </TabsTrigger>
              <TabsTrigger value="community">
                <span>Community</span>
                <TabCount>{entries.filter((e) => e.category === 'community').length}</TabCount>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Select
            size="sm"
            aria-label="Scope"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            options={[
              { value: 'all', label: 'All scopes' },
              { value: 'global', label: 'Global' },
              { value: 'workspace', label: 'Workspace' },
            ]}
          />
        </ScreenToolbar>
      }
    >
      {visible.length === 0 ? (
        <EmptyState icon="package" title="No matching extensions" prominent />
      ) : (
        <CardGrid minWidth="md" gap="md">
          {visible.map((entry) => (
            <SelectCard
              key={entry.id}
              icon={entry.icon}
              title={entry.name}
              subtitle={entry.id}
              badges={<Badge tone={entry.enabled ? 'ok' : 'neutral'}>{entry.enabled ? 'Active' : 'Disabled'}</Badge>}
              description={entry.description}
              selected={selectedId === entry.id}
              onSelect={() => onSelect(entry.id)}
              footer={<span className="text-muted mono">{entry.scope}</span>}
            />
          ))}
        </CardGrid>
      )}
    </Screen>
  )
}
\`\`\`

## 3. Right-Side \`DetailDrawer\` Form

Pair with \`useScreenDrawer\` for URL-hash and Back-stack integration. Form fields use \`md (32px)\` height parity, \`Input\` native \`prefix\`/\`suffix\`, \`ModelPickerControl variant="field"\`, \`Cmd/Ctrl + Enter\` submission, dirty-state gating, and the canonical left-danger / right-cancel / rightmost-primary footer.

\`\`\`tsx
import type { KeyboardEvent, ReactNode } from 'react'
import {
  Badge,
  Button,
  Callout,
  DetailDrawer,
  Field,
  Input,
  ModelPickerControl,
  SegmentedControl,
  Stack,
  Textarea,
} from '@helmx/plugin-client'

interface TierDraft {
  id: string
  mode: 'single' | 'orchestrator'
  model: string
  thinkingLevel: string
  timeoutSec: string
  description: string
}

interface TierFormDrawerProps {
  open: boolean
  mode: 'create' | 'edit'
  draft: TierDraft
  dirty: boolean
  saving: boolean
  error: string | null
  onChange: (patch: Partial<TierDraft>) => void
  onSave: () => void
  onRequestDelete?: () => void
  onClose: () => void
}

export function TierFormDrawer({
  open,
  mode,
  draft,
  dirty,
  saving,
  error,
  onChange,
  onSave,
  onRequestDelete,
  onClose,
}: TierFormDrawerProps): ReactNode {
  const canSave = !saving && (mode === 'create' || dirty)

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSave) {
      e.preventDefault()
      onSave()
    }
  }

  return (
    <DetailDrawer
      open={open}
      onClose={onClose}
      title={mode === 'create' ? 'New Tier' : \`tier/\${draft.id}\`}
      titleExtra={mode === 'edit' ? <Badge tone="ok">Active</Badge> : undefined}
      footer={
        <>
          {mode === 'edit' && onRequestDelete !== undefined && (
            <Button variant="danger" size="sm" icon="trash-2" disabled={saving} onClick={onRequestDelete}>
              Delete
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon="check"
            pending={saving}
            disabled={!canSave}
            onClick={onSave}
          >
            {mode === 'create' ? 'Create' : 'Save'}
          </Button>
        </>
      }
    >
      <div onKeyDown={handleKeyDown}>
        <Stack gap="md">
          {error !== null && <Callout tone="err">{error}</Callout>}

          {mode === 'create' && (
            <Field label="Tier ID" required hint="Lowercase letters, digits, hyphens.">
              <Input
                prefix="tier/"
                mono
                value={draft.id}
                disabled={saving}
                placeholder="fast"
                onChange={(e) => onChange({ id: e.target.value })}
              />
            </Field>
          )}

          <Field label="Routing Mode" htmlFor={false}>
            <SegmentedControl
              size="sm"
              aria-label="Routing mode"
              value={draft.mode}
              disabled={saving}
              onValueChange={(next) => onChange({ mode: next === 'orchestrator' ? 'orchestrator' : 'single' })}
              items={[
                { value: 'single', label: 'Single Model' },
                { value: 'orchestrator', label: 'Orchestrator' },
              ]}
            />
          </Field>

          <Field label="Target Model" htmlFor={false} required>
            <ModelPickerControl
              variant="field"
              size="md"
              buttonAriaLabel="Target model"
              effectiveModel={draft.model || undefined}
              activeThinkingLevel={draft.thinkingLevel}
              allowTiers={false}
              enableShortcut={false}
              disabled={saving}
              onApply={(model, level) => onChange({ model, thinkingLevel: level ?? '' })}
              onResetDefault={() => onChange({ model: '', thinkingLevel: '' })}
            />
          </Field>

          <Field label="Timeout">
            <Input
              type="number"
              mono
              suffix="s"
              min={5}
              max={600}
              value={draft.timeoutSec}
              disabled={saving}
              onChange={(e) => onChange({ timeoutSec: e.target.value })}
            />
          </Field>

          <Field label="Description">
            <Textarea
              rows={2}
              value={draft.description}
              disabled={saving}
              placeholder="When should agents choose this tier?"
              onChange={(e) => onChange({ description: e.target.value })}
            />
          </Field>
        </Stack>
      </div>
    </DetailDrawer>
  )
}
\`\`\`

## 4. Narrow \`settingsPanel\`, \`workbenchPanel\`, or Drawer \`slot\`

In narrow containers (\`360–520px\`), lock controls to \`sm (28px)\` and \`xs (22px)\`, omit redundant view-level headers, and compose with \`Card(variant="subtle")\`, \`KvGrid\`, and \`List(density="compact")\`—never \`CardGrid\` or \`> 3\`-column \`DataTable\`.

\`\`\`tsx
import type { ReactNode } from 'react'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  KvGrid,
  List,
  ListRow,
  Stack,
  StatusLight,
  Switch,
} from '@helmx/plugin-client'

interface TunnelEntry {
  id: string
  listen: string
  target: string
  active: boolean
  connections: number
}

interface NodeTunnelsSlotProps {
  nodeId: string
  isOnline: boolean
  tunnels: ReadonlyArray<TunnelEntry>
  onToggle: (id: string, next: boolean) => void
  onOpenFullScreen: () => void
  onStop: (id: string) => void
}

export function NodeTunnelsSlot({
  nodeId,
  isOnline,
  tunnels,
  onToggle,
  onOpenFullScreen,
  onStop,
}: NodeTunnelsSlotProps): ReactNode {
  return (
    <Stack gap="md">
      <Card
        variant="subtle"
        title="Port Forwards"
        actions={
          <Button variant="secondary" size="sm" icon="external-link" onClick={onOpenFullScreen}>
            Manage
          </Button>
        }
      >
        <KvGrid
          items={[
            { key: 'Node', value: <span className="mono">{nodeId}</span> },
            { key: 'Status', value: <Badge tone={isOnline ? 'ok' : 'warn'}>{isOnline ? 'Online' : 'Offline'}</Badge> },
            { key: 'Active rules', value: <span className="tabular-nums">{tunnels.filter((t) => t.active).length}</span> },
          ]}
        />
      </Card>

      {tunnels.length === 0 ? (
        <EmptyState compact icon="network" title="No port forwards on this node" />
      ) : (
        <List density="compact" label="Node port forwards">
          {tunnels.map((tunnel) => (
            <ListRow
              key={tunnel.id}
              interactive={false}
              leading={<StatusLight tone={tunnel.active ? 'done' : 'blocked'} label={tunnel.active ? 'Active' : 'Stopped'} />}
              title={<span className="mono">{tunnel.listen}</span>}
              meta={<span className="mono">-{'>'} {tunnel.target}</span>}
              trailing={
                <Stack direction="row" align="center" gap="sm">
                  <Badge tone="neutral" mono>{tunnel.connections}</Badge>
                  <Switch
                    checked={tunnel.active}
                    disabled={!isOnline}
                    aria-label={\`Toggle \${tunnel.listen}\`}
                    onChange={(checked) => onToggle(tunnel.id, checked)}
                  />
                </Stack>
              }
              actions={
                <IconButton
                  icon="x"
                  size="xs"
                  variant="ghost"
                  label={\`Remove \${tunnel.listen}\`}
                  onClick={() => onStop(tunnel.id)}
                />
              }
            />
          ))}
        </List>
      )}
    </Stack>
  )
}
\`\`\`
`

export const HELMX_CLI_UI_HIG_MD = `${HELMX_UI_HIG_BODY_MD}\n\n---\n\n${HELMX_UI_HIG_PATTERNS_MD}`
