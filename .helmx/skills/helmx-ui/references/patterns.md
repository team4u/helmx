# Canonical JSX Patterns (Helmx UI HIG)

All recipes below compile against `@helmx/ui` and `@helmx/plugin-client` with zero private stylesheet, zero `variant="default"`, zero retired legacy container/modal/tab/kbd classes, zero Emoji, and full SSR (`renderToString`) and Fast Refresh compliance.

## 1. Management Screen with Hairline Roster List

Use for rules, port mappings, scheduled triggers, workflow libraries, run logs, templates, and tier rosters.

```tsx
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
} from '@helmx/ui'
import {
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
      key: `delete:${target.id}`,
      onSuccess: () => ctx.notify(`Deleted ${target.name}`),
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
                  label={`Delete ${item.name}`}
                  pending={actions.pendingKey === `delete:${item.id}`}
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
        description={pendingDelete ? `Delete "${pendingDelete.name}"? This cannot be undone.` : ''}
        confirmText="Delete"
        cancelText="Cancel"
        danger
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </Screen>
  )
}
```

## 2. Catalog Screen with Object Card Grid

Use for browsable asset or marketplace catalogs (Profiles, Model Providers, Plugins, Skills, Nodes). Follow `SelectCard` anatomy discipline: put domain capability/status tags inside the card body (`children`) using sharp `5px` `<Badge>` (no pill mixing), and keep `footer` strictly single-line with `size="xs"` actions so cards in the same row align horizontally.

```tsx
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
  Stack,
  TabCount,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@helmx/ui'

interface CatalogEntry {
  id: string
  name: string
  category: 'core' | 'community'
  scope: string
  icon: string
  description: string
  capabilities: ReadonlyArray<string>
  enabled: boolean
}

interface CatalogScreenProps {
  entries: ReadonlyArray<CatalogEntry>
  selectedId?: string
  onSelect: (id: string) => void
  onOpenView: (id: string) => void
  onInstall: () => void
}

export function CatalogScreen({ entries, selectedId, onSelect, onOpenView, onInstall }: CatalogScreenProps): ReactNode {
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
              footer={
                <Stack direction="horizontal" align="center" justify="between" gap="sm">
                  <span className="text-muted mono">{entry.scope}</span>
                  <Button
                    variant="secondary"
                    size="xs"
                    icon="external-link"
                    onClick={() => onOpenView(entry.id)}
                  >
                    Open
                  </Button>
                </Stack>
              }
            >
              {entry.capabilities.length > 0 && (
                <Stack direction="horizontal" gap="xs" wrap>
                  {entry.capabilities.map((cap) => (
                    <Badge key={cap} tone="neutral">
                      {cap}
                    </Badge>
                  ))}
                </Stack>
              )}
            </SelectCard>
          ))}
        </CardGrid>
      )}
    </Screen>
  )
}
```

## 3. Right-Side `DetailDrawer` Form

Pair with `useScreenDrawer` for URL-hash and Back-stack integration. Headers are minimal and icon-free (no left icon box); create mode shows only `"New <Entity>"`, while edit mode shows the entity title, status `<Badge>`, and `<MonoId>` in `meta`. Form fields use `md (32px)` height parity, `Input` native `prefix`/`suffix`, `ModelPickerControl variant="field"`, `Cmd/Ctrl + Enter` submission, dirty-state gating, and the canonical left-danger / right-cancel / rightmost-primary footer.

```tsx
import type { KeyboardEvent, ReactNode } from 'react'
import {
  Badge,
  Button,
  Callout,
  DetailDrawer,
  Field,
  Input,
  MonoId,
  SegmentedControl,
  Stack,
  Textarea,
} from '@helmx/ui'
import { ModelPickerControl } from '@helmx/plugin-client'

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
      title={mode === 'create' ? 'New Tier' : `tier/${draft.id}`}
      titleExtra={mode === 'edit' ? <Badge tone="ok">Active</Badge> : undefined}
      meta={mode === 'edit' ? <MonoId value={draft.id} /> : undefined}
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

          <Field label="Target Model" required>
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
```

## 4. Narrow `settingsPanel`, `workbenchPanel`, or Drawer `slot`

In narrow containers (`360–520px`), lock controls to `sm (28px)` and `xs (22px)`, omit redundant view-level headers, and compose with `Card(variant="subtle")`, `KvGrid`, and `List(density="compact")`—never `CardGrid` or `> 3`-column `DataTable`. When a narrow drawer/container needs divider tabs, use `Tabs(variant="underline")` with `<TabsList scrollable>` and `<TabCount>`.

```tsx
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
} from '@helmx/ui'

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
                <Stack direction="horizontal" align="center" gap="sm">
                  <Badge tone="neutral" mono>{tunnel.connections}</Badge>
                  <Switch
                    checked={tunnel.active}
                    disabled={!isOnline}
                    aria-label={`Toggle ${tunnel.listen}`}
                    onChange={(checked) => onToggle(tunnel.id, checked)}
                  />
                </Stack>
              }
              actions={
                <IconButton
                  icon="x"
                  size="xs"
                  variant="ghost"
                  label={`Remove ${tunnel.listen}`}
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
```

## 5. Centered `ModalDialog`, Structured `DropdownMenuItem`, Subtle `SearchBox`, and `Kbd`

Use `<ModalDialog size="sm|md|lg|fullscreen">` for short forms and dialogs (never raw `.modal-backdrop`/`.modal-header`/`.modal-footer`), `<DropdownMenuItem>` structured slots for action menus, `<SearchBox surface="subtle">` inside narrow pickers/popovers, `<Tabs variant="underline"><TabsList scrollable>` for divider tab bars, and `<Kbd>` for keyboard shortcut hints.

```tsx
import { useState, type ReactNode } from 'react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  IconButton,
  Input,
  Kbd,
  ModalDialog,
  SearchBox,
  Stack,
  TabCount,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@helmx/ui'

interface SavePresetModalProps {
  open: boolean
  saving: boolean
  activeMode: 'compact' | 'detailed'
  onModeChange: (next: 'compact' | 'detailed') => void
  onSave: (name: string) => void
  onReset: () => void
  onClose: () => void
}

export function SavePresetModal({
  open,
  saving,
  activeMode,
  onModeChange,
  onSave,
  onReset,
  onClose,
}: SavePresetModalProps): ReactNode {
  const [tab, setTab] = useState<'save' | 'browse'>('save')
  const [name, setName] = useState('')
  const [filter, setFilter] = useState('')

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      size="sm"
      icon="bookmark-plus"
      title="Save Preset"
      description="Store the current filter set for quick reuse."
      closeDisabled={saving}
      headerActions={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton icon="more-horizontal" size="sm" variant="ghost" label="Preset options" />
          </DropdownMenuTrigger>
          <DropdownMenuContent portalled align="end">
            <DropdownMenuItem
              icon="layout-list"
              description="Dense single-line rows"
              shortcut={<Kbd size="sm" desktopOnly>1</Kbd>}
              checked={activeMode === 'compact'}
              onSelect={() => onModeChange('compact')}
            >
              Compact density
            </DropdownMenuItem>
            <DropdownMenuItem
              icon="rows-3"
              description="Show descriptions and tags"
              shortcut={<Kbd size="sm" desktopOnly>2</Kbd>}
              checked={activeMode === 'detailed'}
              onSelect={() => onModeChange('detailed')}
            >
              Detailed density
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon="rotate-ccw" danger onSelect={onReset}>
              Reset to defaults
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
      footer={
        <>
          <span className="text-muted">
            Press <Kbd size="sm" desktopOnly>Esc</Kbd> to close
          </span>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon="check"
            pending={saving}
            disabled={name.trim() === ''}
            onClick={() => onSave(name.trim())}
          >
            Save
          </Button>
        </>
      }
    >
      <Stack gap="md">
        <Tabs value={tab} onValueChange={(next) => setTab(next === 'browse' ? 'browse' : 'save')} variant="underline">
          <TabsList scrollable aria-label="Preset sections">
            <TabsTrigger value="save">
              <span>New</span>
            </TabsTrigger>
            <TabsTrigger value="browse">
              <span>Existing</span>
              <TabCount>3</TabCount>
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {tab === 'save' ? (
          <Field label="Preset Name" required>
            <Input
              value={name}
              disabled={saving}
              placeholder="e.g. active-errors"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        ) : (
          <SearchBox
            size="sm"
            surface="subtle"
            value={filter}
            onChange={setFilter}
            placeholder="Filter saved presets..."
            ariaLabel="Filter saved presets"
          />
        )}
      </Stack>
    </ModalDialog>
  )
}
```

## 6. Interactive Popover List, Collapsible Sections, `BatchBar`, and `MasterDetail`

Compose `<MasterDetail>` inside `<Screen layout="full-bleed">` for responsive two-pane stages, collapsible `<ScreenSection collapsible rule count>` + `<BatchBar>` for grouped governance, and `<PopoverHeader>` + `<PopoverItem>` + `useListKeyboardNav` for keyboard-navigable picker popovers.

```tsx
import { useState, type ReactNode } from 'react'
import {
  BatchBar,
  Button,
  EmptyState,
  Kbd,
  List,
  ListRow,
  MasterDetail,
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverItem,
  PopoverTrigger,
  Screen,
  ScreenSection,
  ScreenToolbar,
  SearchBox,
  useListKeyboardNav,
} from '@helmx/ui'

interface WorkspaceItem {
  id: string
  name: string
  path: string
}

export function WorkspaceInspectorStage({ items }: { items: WorkspaceItem[] }): ReactNode {
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [activeId, setActiveId] = useState<string | null>(items[0]?.id ?? null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState('')

  const filtered = items.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()))
  const pickItem = (id: string): void => {
    setActiveId(id)
    setPickerOpen(false)
  }
  const nav = useListKeyboardNav({
    count: filtered.length,
    enabled: pickerOpen,
    onSelect: (idx) => {
      const picked = filtered[idx]
      if (picked !== undefined) pickItem(picked.id)
    },
  })

  const selectedItem = items.find((item) => item.id === activeId)

  return (
    <Screen
      layout="full-bleed"
      title="Workspace Files"
      toolbar={
        <ScreenToolbar
          actions={
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <Button size="sm">Quick jump</Button>
              </PopoverTrigger>
              <PopoverContent align="end">
                <PopoverHeader divider title="Jump to file" trailing={<Kbd size="sm">Enter</Kbd>} />
                <SearchBox
                  size="sm"
                  surface="subtle"
                  value={query}
                  onChange={setQuery}
                  onKeyDown={nav.onKeyDown}
                  placeholder="Filter files..."
                  ariaLabel="Filter files"
                />
                {filtered.map((item, idx) => (
                  <PopoverItem
                    key={item.id}
                    ref={nav.getItemRef(idx)}
                    icon="file-text"
                    meta={item.path}
                    active={idx === nav.activeIndex}
                    selected={item.id === activeId}
                    onMouseEnter={() => nav.setActiveIndex(idx)}
                    onClick={() => pickItem(item.id)}
                  >
                    {item.name}
                  </PopoverItem>
                ))}
              </PopoverContent>
            </Popover>
          }
        >
          {selectedIds.length > 0 && (
            <BatchBar
              selectedCount={selectedIds.length}
              selectedLabel={`${selectedIds.length} selected`}
              onExit={() => setSelectedIds([])}
              actions={<Button size="sm" onClick={() => setSelectedIds([])}>Clear</Button>}
            />
          )}
        </ScreenToolbar>
      }
    >
      <MasterDetail
        masterWidth={300}
        masterLabel="File list"
        detailLabel="File details"
        mobilePane={selectedItem ? 'detail' : 'master'}
        master={
          <ScreenSection collapsible rule title="Changed files" count={filtered.length}>
            <List density="compact">
              {filtered.map((item) => (
                <ListRow
                  key={item.id}
                  title={item.name}
                  meta={item.path}
                  selected={item.id === activeId}
                  onSelect={() => setActiveId(item.id)}
                />
              ))}
            </List>
          </ScreenSection>
        }
        detail={
          selectedItem ? (
            <ScreenSection title={selectedItem.name}>
              <div className="mono text-muted">{selectedItem.path}</div>
            </ScreenSection>
          ) : (
            <EmptyState compact title="Select a file" />
          )
        }
      />
    </Screen>
  )
}
```
