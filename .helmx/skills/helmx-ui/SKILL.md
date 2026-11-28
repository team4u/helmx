---
name: helmx-ui
description: Use when designing, implementing, or refactoring any Helmx Web UI—core @helmx/web pages (Five System Centers, Conversation Overview, workbench, modals), built-in plugins, or external micro-apps and plugin client/*.tsx views. Defines the single Helmx UI Human Interface Guidelines (Quiet Surface principles, 32/28/22px control scale, 5-variant Button, physical-location Tabs, unified overlay & DropdownMenuItem, SearchBox surfaces, ModalDialog & Kbd, SelectCard anatomy, legacy container retirement, composer toolbar pills, EmptyState/LoadingState, unified Screen toolbar shell, container density rules, Creative Zone boundaries, and pre-delivery checklist).
---

# Helmx UI Human Interface Guidelines (HIG)

## Core Principle: Diverse Domain Patterns, One Unified Shell and Atom Kit

> **Diverse list and stage patterns by domain; single unified shell, atoms, and interaction grammar across core and plugins.**
> （模式随业务多元，外壳与原子零件全站唯一。）

Core `@helmx/web` views (Five System Centers, Conversation Overview, workbench, modals) and all plugins (built-in and external micro-apps) share **100% of the same `@helmx/ui` primitives, geometry tokens, and interaction grammar** (with plugin runtime hooks, slots, and host-coupled widgets such as `ModelPickerControl` provided by `@helmx/plugin-client`). Never create parallel page shells, legacy aliases, or per-page form/button restyles.

## 1. Quiet Surface Visual Principles

- **Paper-neutral surfaces and hairline structure**: Build hierarchy with semantic surface tokens (`--bg`, `--bg-elevated`, `--bg-subtle`, `--bg-muted`) and `1px` hairlines (`--border`, `--line-2`), not heavy drop shadows or saturated fills.
- **Restrained color semantics**: Reserve `--accent`, `--ok`, `--warn`, and `--err` (plus their `*-bg` / `*-border` pairs) for focal actions and honest status signals. Always style via host CSS tokens so light and dark themes stay balanced—never hardcode hex colors.
- **Numeric and technical typography**: Use `tabular-nums` on counts, durations, quotas, and timestamps; use monospace (`mono` / `--font-mono`) for IDs, model keys, paths, ports, and cron expressions.
- **Zero Emoji iron rule**: Never put Emoji anywhere in UI copy, titles, navigation, buttons, badges, or cards. Use plain text and `lucide-react` vector icons via `<HelmxIcon>`.

## 2. Control Scale (32 / 28 / 22px Parity)

All interactive controls share three locked height tiers defined in `tokens.css`. Controls placed side-by-side in the same row MUST use the same tier for exact pixel-height alignment.

| Tier | Height Token | Radius Token | Font / Icon | Primary Placement | Exact Height-Parity Controls |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`md`** | `--control-h-md: 32px` | `--control-radius-md` (`--radius-sm`, 7px) | `--control-font-md: 13px` / 14px | Drawer and modal form fields, standalone input rows, dialog footers | `Button`, `IconButton`, `Input`, `Select`, `MultiSelect`, `SearchBox`, `SegmentedControl`, `ModelPickerControl(variant="field")` |
| **`sm`** | `--control-h-sm: 28px` | `--control-radius-sm` (`--radius-xs`, 5px) | `--control-font-sm: 12px` / 13px | **Topbar actions, `ScreenToolbar`, narrow panels, list/card inline controls** | All controls above + `Tabs(variant="pills")` (radius `999px`) |
| **`xs`** | `--control-h-xs: 22px` | `--control-radius-xs` (`--radius-xs`, 5px) | `--control-font-xs: 11px` / 12px | List/table trailing micro-buttons, `SelectCard` single-line footer actions, composer toolbar pills, tool trace actions | `Button`, `IconButton`, `.helmx-toolbar-pill` (`Badge` is a fixed `20px` sharp `5px` tag; `Kbd` is `20px` `md` / `18px` `sm`) |

## 3. Base Controls Contract

### 5-Variant `Button` and `IconButton`

The ambiguous `'default'` variant is **removed** from `Button`, `IconButton`, and `Tabs`—never write `variant="default"`. `Button` defaults to `variant="secondary"`, `size="md"`; `IconButton` defaults to `variant="ghost"`, `size="md"`.

| Variant | Role | Hard Rules |
| :--- | :--- | :--- |
| **`secondary`** | Standard actions (Refresh, Export, Import, Save template, Cancel) | Default `Button` variant; white surface + `1px` border. |
| **`primary`** | Single primary create or submit action | **At most 1 `primary` per visual focus zone** (topbar actions, empty state, drawer footer, modal footer); always rightmost (immediately before the split toggle in topbars). |
| **`ghost`** | Row-trailing icons, close buttons, subtle cancel | Default `IconButton` variant; borderless transparent. |
| **`danger`** | Destructive delete/remove/reset actions | Irreversible actions MUST be gated by `<ConfirmDialog danger ... />`. |
| **`inline`** | Inline expand, retry, jump micro-actions | Borderless compact text action. |

- **Async actions**: Always pass `pending` (pairs cleanly with `usePluginAction`).
- **Icon-only buttons**: Always use `<IconButton>` with a non-empty `label` (or `aria-label`)—never an unlabeled `<Button>`.
- **Responsive topbar labels**: Wrap topbar action labels in `<span className="pane-action-label">` so narrow panes collapse cleanly to centered icons with zero ghost gap.

### `SearchBox`, `Input`, and `ModelPickerControl`

- **`SearchBox`**: Accepts `variant?: 'default' | 'toolbar'`, `surface?: 'default' | 'subtle' | 'frameless'` (default `'default'`), and `size?: 'sm' | 'md'` (default `'md'`).
  - `surface="default"`: elevated bordered input for toolbars (`<SearchBox variant="toolbar" size="sm" />`: `28px` height, `200–260px` adaptive on the right, auto-expands to `100%` at `<= 680px` `@container`/`@media`, single clear button, built-in `Esc` clear-then-blur inside `ScreenToolbar`).
  - `surface="subtle"`: muted fill for sidebars, popovers, and searchable selects (also used internally by `MultiSelect`).
  - `surface="frameless"`: borderless transparent input for command palettes and modal header search rows.
  - **Never hand-roll search inputs in sidebars, popovers, or modals, and never use `<input type="search">`**.
- **`Input`**: Supports `size?: 'sm' | 'md'`, `prefix?: ReactNode` (e.g. `prefix="tier/"`), `suffix?: ReactNode` (e.g. `suffix="s"`), `inputClassName?: string`, `mono`, and `invalid`. The outer `.helmx-input-wrap` carries the border and `:focus-within` ring with full `FieldContext` wiring—never build ad-hoc prefix wrapper divs.
- **`ModelPickerControl`**: Supports `variant?: 'composer' | 'field'` (default `'composer'`), `size?: 'sm' | 'md'` (default `'md'`), `invalid?: boolean`, and `className?: string`. Use `variant="field"` inside all forms and drawers (`32px`/`28px` bordered trigger matching `Select`, defaults `popoverSide="bottom"`, auto-connects to enclosing `<Field>`). Never restyle `.composer-model-button` locally.

### Selector & Physical-Location Tab Rules

Choose the selector strictly by physical placement and cardinality. `TabsVariant` is `'underline' | 'segmented' | 'pills'`—**zero `variant="default"`**.

| Scenario / Physical Placement | Required Primitive | Hard Rules |
| :--- | :--- | :--- |
| **Container or drawer divider tab bars** (e.g. Workbench drawer tabs, inspector sub-panes) | `Tabs(variant="underline")` + `<TabsList scrollable>` + `<TabCount>` | **Use `underline` ONLY for container/drawer divider tab bars** (`36px` Quiet Surface bar with crisp `2px` bottom indicator and built-in SSR-safe overflow fade masks via `scrollable`). Never stack an underline bar above `ScreenToolbar`. |
| **2–5 mutually exclusive views or modes** | `SegmentedControl(size="sm")` or `Tabs(variant="segmented", size="sm")` | Keep labels short; place on the left of `ScreenToolbar` or inline in form fields. |
| **Multi-filter status/category bars with live counts** | `Tabs(variant="pills", size="sm")` + `<TabCount>` (or `Tabs.Count`) | Uses borderless soft `--bg-muted` active fill + inline `tabular-nums` count; never nest bordered `<Badge>` inside triggers. |
| **5+ options or dynamic resources (nodes, profiles, scopes)** | Radix `Select` / `MultiSelect` (`searchable` for long lists) | **Native `<select>` is strictly forbidden repo-wide.** |
| **Boolean state** | `Switch` (immediate effect) or `Checkbox` (deferred submit / batch selection) | Pair with `<Field htmlFor={false}>` when rendering a self-labeled control or multi-control group. |

### Overlays, Modals, Shortcuts, Composer Pills, and Empty / Loading States

- **Unified Overlay Surface, `<PopoverHeader>`, `<PopoverItem>`, & `<DropdownMenuItem>`**: `Popover`, `DropdownMenu`, `Select`, and `ModelPicker` share ONE canonical overlay surface (`var(--pop-bg)` backdrop-blur, `1px solid var(--border)`, `var(--radius-md)` `10px`, `var(--shadow-lg)`). Never hand-roll popover or menu item CSS; use `<DropdownMenuItem icon description shortcut trailing checked danger>` for dropdown menus, `<PopoverHeader title subtitle trailing divider>` + `<PopoverItem active selected danger icon meta trailing>` inside custom popovers, and `useListKeyboardNav` for keyboard arrow/Home/End/Enter navigation with IME composition guards, boundary clamping, and `scrollIntoView`.
- **`<ModalDialog>` & `<Kbd>`**:
  - Use `<ModalDialog size="sm|md|lg|fullscreen">` (`open`, `onClose`, `title`, `icon?`, `titleExtra?`, `description?`, `flushBody?`, `headerActions?`, `footer?`, `closeDisabled?`, `closeLabel?`, `inline?`, `onOpenAutoFocus?`, `onEscapeKeyDown?`) for all centered modals instead of raw `.modal-backdrop`, `.modal-header`, or `.modal-footer`.
  - Use `<Kbd size="sm|md" desktopOnly?>` (`20px` `md` / `18px` `sm`, monospace shortcut badge) for keyboard shortcuts instead of raw `<kbd className="kbd-hint">` or `<span className="kbd-hint">`.
- **Composer Toolbar Pills**: Composer status pills (e.g. plan mode, active tier, mode indicators) MUST use the shared `22px` (`--control-h-xs`) `.helmx-toolbar-pill` CSS family (`.helmx-toolbar-pill`, `.helmx-toolbar-pill--accent|--warn|--err`, `.helmx-toolbar-pill-main`, `.helmx-toolbar-pill-clear`) instead of per-plugin pill geometry.
- **Empty & Loading States**: Always use `<EmptyState compact|prominent>` and `<LoadingState>` for empty/loading placeholders (`DataTable` empty rows render `<EmptyState compact>` automatically). Ban ad-hoc empty or loading boxes.

## 4. Stage and List Archetypes (5 First-Class + Domain-Extensible)

Choose the stage/list layout that best serves the domain's information model. **Hairline Roster List is NOT the only permitted list layout.**

| Archetype | Shared SDK / Shell Primitive | Best Fit | Structure & Guardrails |
| :--- | :--- | :--- | :--- |
| **1. Hairline Roster List** | `<List density="default\|compact">` + `<ListRow>` | Rules, configs, port mappings, scheduled triggers, workflow libraries, run histories, templates, narrow-panel item lists | `1px` bordered container + hairline dividers; sibling-slot a11y (`<button aria-pressed>` main trigger + always-visible `trailing` + hover/focus-revealed `actions` inside `@media (hover: hover)`, always visible on touch); collapses to single column at `@container (max-width: 680px)` and `@media (max-width: 680px)`. |
| **2. Object Card Grid** | `<CardGrid minWidth="sm\|md\|lg">` + `<SelectCard>` | Browsable asset and marketplace catalogs (Profiles, Model Providers, Plugins/Core Capabilities, Skills, Nodes) | Built-in `32x32` rounded `icon` box (string resolves via `HelmxIcon`), inline header `badges`, 2-line clamped `description`, sibling `actions`, body `children`, and `footer`. **Anatomy discipline**: put domain capability/status tags inside card body (`children`) using sharp `5px` (`--radius-xs`) `<Badge>` (never mix rounded `pill` chips with sharp `<Badge>`); keep `footer` strictly single-line with `size="xs"` actions so cards in the same row align horizontally. Zero per-page card CSS clones. |
| **3. Grouped Triage Stage** | `<Screen toolbar>` + collapsible `<ScreenSection collapsible rule leading count>` + `<BatchBar>` + SDK controls | Multi-dimension operational boards (exemplar: `ConversationOverview`) with status/dimension groups, bulk governance, and aggregate cards with sub-chips | Uses the unified `<Screen toolbar>` shell, collapsible `<ScreenSection>` headers, `<BatchBar>` for multi-item batch actions, `sm (28px)` filter controls, `sp.*` URL params, and SDK buttons/menus/badges. |
| **4. Structured Data Table** | `<DataTable loading empty columns label>` | **Only** multi-column horizontal numeric comparison and aligned scanning (quota matrices, ledgers, billing reports) | `--bg-subtle` header, `tabular-nums` numbers, automatic `<LoadingState>` and `<EmptyState compact>` rows. **Hard rule**: narrow panels/drawers (`< 560px`) MUST NEVER exceed 3 columns—use `<List>` instead. |
| **5. Master-Detail / Full-Bleed Canvas** | `<Screen layout="full-bleed">` + `<MasterDetail master detail mobilePane masterWidth>` | Side-by-side Diff inspectors (`builtin:changes`), DAG/topology canvases, zoomable diagrams (`builtin:mermaid`), custom multi-pane workbenches | Edge-to-edge stage below the unified 46px topbar and optional sticky `toolbar`; `<MasterDetail>` automatically collapses to single-pane `mobilePane` switching (`master` / `detail`) at `@container (max-width: 680px)`. |

**New domain-specific patterns are explicitly welcome**: when none of the 5 archetypes fits (e.g., Kanban lanes, calendar matrix, waterfall trace), design a domain-native stage while composing exclusively from the unified `<Screen>` topbar/toolbar/drawer shell, `32/28/22px` SDK controls, semantic tokens, and standard interaction grammar.

## 5. Single Unified Page Shell and 4 Container Densities

Core System Centers, Conversation Overview, and Plugin Screens share ONE `<Screen>` shell:

```text
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
```

- **Locked single-layer toolbar**: Always **switch/filter on the left, search on the right** (`<ScreenToolbar actions={<SearchBox ... />}>` or flex-aligned right cluster). Never stack an underline tab row above a second toolbar, and never put Create/Primary actions inside `ScreenToolbar`—view-level actions belong in `<Screen actions={...}>`.
- **Host bridge props**: `<Screen>` provides `toolbar`, `topbar`, `icon`, `topbarEnd`, `banner`, `overlays`, `dataView`, `contentClassName`, `bodyId`, and `bodyRole` so host views use the exact same shell without parallel wrappers.

### 4 Container Density Boundaries

1. **Full-Screen Stage (`Screen`)**: Topbar and toolbar locked to `sm (28px)`. All primary header bars (`.pane-topbar`, docked `.drawer-stack-header`, and `<DetailDrawer>`) share a unified `46px` single-line header baseline (`8px` top + `28px` title row / `btn-icon-sm` close button + `9px` bottom + `1px` border) with theme-aware `--shadow-drawer` elevation. Selecting or creating an item opens a right-side `<DetailDrawer>` (`520–560px` desktop, `100vw` at `<= 680px`) paired with `useScreenDrawer` for URL-hash and browser/mobile Back sync:
   - **Minimal icon-free header**: `DetailDrawer` renders `title` + optional `titleExtra` status `<Badge>` + optional `<MonoId>` `meta` + optional `belowTitle` + right close button — never render a left `36x36` square icon box (`DetailDrawer` intentionally has no `icon` prop).
   - **Create vs Edit parity**: Create drawers show only `"New <Entity>"` (no `meta` ID, no status badge); edit drawers show the entity name as `title`, status `<Badge>` in `titleExtra`, and `<MonoId>` in `meta`.
   - **Form grouping & footer**: Single-group forms (`<= 6` fields) stack `<Field>` in `<Stack gap="md">`; multi-section forms group sections in `<Card variant="subtle">`; all fields use `md (32px)` parity, `Cmd/Ctrl + Enter` submit, dirty-state gating on edit, and a `size="sm"` sticky footer (`variant="danger" size="sm"` delete on edit—never `ghost` + `.text-err` or retired `.btn-danger-sm`—plus `<div className="flex-1" />`, `ghost` cancel, and rightmost `primary` create/save).
2. **Narrow Side Panels (`workbenchPanel`, `settingsPanel`, drawer `slot`, `360–520px`)**: Use `sm (28px)` and `xs (22px)` controls only. Never render multi-column `<CardGrid>` or `> 3`-column `<DataTable>`; compose with `<KvGrid>`, `<List density="compact">`, and single-column `<Card variant="subtle">`. Use `Tabs(variant="underline")` + `<TabsList scrollable>` for divider tab bars. Never repeat a redundant top-level screen title.
3. **Timeline Inline Blocks (`toolView`, `timelineRenderer`, `json-render`)**: Follow Quiet Surface `26px` single-line traces with left chevron at `x=8px` (`6px` in `<= 450px` panes). Keep inline cards compact; on `replaceRow` cards, let the host IO panel handle input/output disclosure instead of rendering duplicate `ToolCallDetails`.
4. **Centered Modals (`<ModalDialog>` / `<ConfirmDialog>`)**: Use `<ModalDialog size="sm|md|lg|fullscreen">` (`sm`/`md` cover standard `440–560px` modals; `lg`/`fullscreen` are reserved for rich previews or diff/diagram inspection). Headers align to the same `46px` single-line baseline (`min-height: 46px`, `28px` `.helmx-modal-title-row` & `.helmx-modal-icon` aligned with the `28px` close button) over theme-aware `--shadow-modal` elevation and `--radius-lg` corners. Strictly limited to destructive confirmation, short forms (`<= 4` fields, e.g., Save Template or Install Plugin), single-credential entry, keyboard cheat sheets, and media preview. Never cram catalogs, multi-dimensional search, or management lists into a modal.

## 6. Creative Zone Boundaries and CSS Hygiene

- **Where to express domain craft**: Inside `<Screen layout="full-bleed">` canvases (Diff viewers, DAGs, zoomable diagrams, charts) and domain micro-visuals inside cards or `ListRow` slots (`meta`, `leading`, `trailing`).
- **Zero private CSS by default**: Compose with SDK primitives and host tokens (`--space-1..6`, `--bg-*`, `--fg-*`, `--border`, `--radius-*`). Add a local `styles.css` only when host primitives do not cover a domain structure. Never copy host button/input/table/card/popover/modal CSS or edit `packages/web/src/styles.css` from a plugin.
- **Legacy container & control class retirement (statically enforced)**: Raw `.btn`, `.btn-*`, `.input`, `.input-sm`, `.section-flat`, `.form-grid`, `.kv-list`, `.card`, `.tabs-bar`, `.tab-btn`, `.modal-header`, `.modal-footer`, `.dropdown-panel`, and `.kbd-hint` are strictly forbidden on intrinsic lowercase JSX elements (`<div>`, `<span>`, `<button>`, `<input>`, `<kbd>`, etc.; enforced by `pnpm check:hygiene` and `helmx plugins doctor`). Always use `<Button>`, `<IconButton>`, `<Input>`, `<Card variant="subtle">`, `<Field>`, `<KvGrid>`, `<List>`, `<ModalDialog>`, `<Tabs>`, `<DropdownMenu>`, and `<Kbd>`.
- **Mandatory `:hover` gate**: Every `:hover` rule MUST sit inside `@media (hover: hover)` (enforced by `pnpm check:hygiene` and `helmx plugins doctor`). Any hover-revealed control MUST remain visible under `@media (hover: none)` or via `:focus-within`.
- **No bulk inline styles**: Avoid `style` objects except dynamic coordinates/dimensions; use SDK primitives (`Stack`, `Card`, `List`, `KvGrid`, `Field`) and tokens.

## 7. Pre-Delivery Checklist

- [ ] **Zero Emoji** across all UI copy, titles, icons, badges, and empty states.
- [ ] **Zero `variant="default"`** on `Button`, `IconButton`, or `Tabs`; at most **1 `primary`** per focus zone, placed rightmost.
- [ ] **Physical-location Tabs**: `underline` + `<TabsList scrollable>` ONLY for container/drawer divider bars; `segmented` for 2–5 modes; `pills` + `<TabCount>` for multi-filter bars.
- [ ] **Zero native `<select>`**, **zero `<input type="search">`**, and **zero hand-rolled search/popover/modal/kbd/master-detail/batch-bar markup**: use `<Select>`/`<MultiSelect>`, `<SearchBox surface="default|subtle|frameless">`, `<PopoverHeader>`/`<PopoverItem>`/`useListKeyboardNav`, `<DropdownMenuItem icon description shortcut trailing checked danger>`, `<ModalDialog size="sm|md|lg|fullscreen">`, `<MasterDetail>`, `<ScreenSection collapsible>`, `<BatchBar>`, and `<Kbd>`.
- [ ] **Zero retired legacy classes on intrinsic tags**: no raw `.btn*` (including retired `.btn-danger-sm`), `.input*`, `.section-flat`, `.form-grid`, `.kv-list`, `.card`, `.tabs-bar`, `.tab-btn`, `.modal-header`, `.modal-footer`, `.dropdown-panel`, `.kbd-hint`, or `.primary-drawer-icon-wrap`.
- [ ] **Exact height parity**: `md (32px)` in drawer/modal forms, `sm (28px)` in topbars/toolbars/narrow panels, `xs (22px)` for row micro-actions, `SelectCard` single-line footers, and `.helmx-toolbar-pill` composer pills.
- [ ] **`SelectCard` anatomy & Empty/Loading discipline**: domain capability/status tags live inside card body (`children`) as sharp `5px` `<Badge>` (no pill mixing); card `footer` stays single-line at `size="xs"`; empty/loading states use `<EmptyState compact|prominent>` and `<LoadingState>`.
- [ ] **Single-layer `<Screen toolbar={<ScreenToolbar />}>`**: left switch/filter, right `SearchBox(variant="toolbar", size="sm")`; view-level Create/Refresh in `<Screen actions>` with `<span className="pane-action-label">`.
- [ ] **Right-side `DetailDrawer` + `useScreenDrawer` with minimal icon-free header & Create/Edit parity**: `46px` single-line header baseline and `--shadow-drawer` elevation, no `36x36` icon box; create shows `"New <Entity>"` with no `meta` ID/status badge, edit shows entity name + `<Badge>` in `titleExtra` + `<MonoId>` in `meta`; `size="sm"` footer with `variant="danger" size="sm"` delete (never `ghost` + `.text-err`) and `ConfirmDialog(danger)` for irreversible deletes; `< 560px` panels have no `CardGrid` and `<= 3` `DataTable` columns.
- [ ] **CSS & runtime hygiene**: all `:hover` inside `@media (hover: hover)`, light + dark semantic tokens only, Fast Refresh compliant (`.tsx` exports components and types only), SSR `renderToString` safe.
- [ ] **Verification**: run `helmx plugins doctor <dir> --json` (external plugins) or `pnpm verify` / relevant unit & browser checks (in-repo).

> Canonical copy-pasteable JSX recipes: see `references/patterns.md` (when reading `.helmx/skills/helmx-ui`) or the **Canonical JSX Patterns** section below (when reading `helmx-cli` `references/ui-hig.md`).
