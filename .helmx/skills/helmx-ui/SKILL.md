---
name: helmx-ui
description: Use when designing, implementing, or refactoring any Helmx Web UI—core @helmx/web pages (Five System Centers, Conversation Overview, workbench, modals), built-in plugins, or external micro-apps and plugin client/*.tsx views. Defines the single Helmx UI Human Interface Guidelines (Quiet Surface principles, 32/28/22px control scale, 5-variant Button, selector and stage archetypes, unified Screen toolbar shell, container density rules, Creative Zone boundaries, and pre-delivery checklist).
---

# Helmx UI Human Interface Guidelines (HIG)

## Core Principle: Diverse Domain Patterns, One Unified Shell and Atom Kit

> **Diverse list and stage patterns by domain; single unified shell, atoms, and interaction grammar across core and plugins.**
> （模式随业务多元，外壳与原子零件全站唯一。）

Core `@helmx/web` views (Five System Centers, Conversation Overview, workbench, modals) and all plugins (built-in and external micro-apps) share **100% of the same `@helmx/plugin-client` primitives, geometry tokens, and interaction grammar**. Never create parallel page shells, legacy aliases, or per-page form/button restyles.

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
| **`xs`** | `--control-h-xs: 22px` | `--control-radius-xs` (`--radius-xs`, 5px) | `--control-font-xs: 11px` / 12px | List/table trailing micro-buttons, tool trace actions, inline copy/clear | `Button`, `IconButton` (`Badge` is a fixed 20px read-only tag) |

## 3. Base Controls Contract

### 5-Variant `Button` and `IconButton`

The ambiguous `'default'` variant is **removed**—never write `variant="default"`. `Button` defaults to `variant="secondary"`, `size="md"`; `IconButton` defaults to `variant="ghost"`, `size="md"`.

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

- **`SearchBox`**: Accepts `variant?: 'default' | 'toolbar'` and `size?: 'sm' | 'md'` (default `'md'`). In toolbars, always use `<SearchBox variant="toolbar" size="sm" value={...} onChange={...} />` (`28px` height, `200–260px` adaptive on the right, auto-expands to `100%` at `<= 680px` `@container`/`@media`, single clear button, built-in `Esc` clear-then-blur inside `ScreenToolbar`). **Never use `<input type="search">`**.
- **`Input`**: Supports `size?: 'sm' | 'md'`, `prefix?: ReactNode` (e.g. `prefix="tier/"`), `suffix?: ReactNode` (e.g. `suffix="s"`), `inputClassName?: string`, `mono`, and `invalid`. The outer `.helmx-input-wrap` carries the border and `:focus-within` ring with full `FieldContext` wiring—never build ad-hoc prefix wrapper divs.
- **`ModelPickerControl`**: Supports `variant?: 'composer' | 'field'` (default `'composer'`), `size?: 'sm' | 'md'` (default `'md'`), `invalid?: boolean`, and `className?: string`. Use `variant="field"` inside all forms and drawers (`32px`/`28px` bordered trigger matching `Select`, defaults `popoverSide="bottom"`, auto-connects to enclosing `<Field>`). Never restyle `.composer-model-button` locally.

### 4-Way Selector Decision Table

| Scenario | Required Primitive | Hard Rules |
| :--- | :--- | :--- |
| **2–4 mutually exclusive sub-views or modes** | `SegmentedControl(size="sm")` or `Tabs(variant="segmented", size="sm")` | Keep labels short; place on the left of `ScreenToolbar`. |
| **Status/category filters with live counts** | `Tabs(variant="pills", size="sm")` + `<TabCount>` (or `Tabs.Count`) | Uses borderless soft `--bg-muted` active fill + inline `tabular-nums` count; never nest bordered `<Badge>` inside triggers. |
| **5+ options or dynamic resources (nodes, profiles, scopes)** | Radix `Select` / `MultiSelect` (`searchable` for long lists) | **Native `<select>` is strictly forbidden repo-wide.** |
| **Boolean state** | `Switch` (immediate effect) or `Checkbox` (deferred submit / batch selection) | Pair with `<Field htmlFor={false}>` when rendering a self-labeled control or multi-control group. |

## 4. Stage and List Archetypes (5 First-Class + Domain-Extensible)

Choose the stage/list layout that best serves the domain's information model. **Hairline Roster List is NOT the only permitted list layout.**

| Archetype | Shared SDK / Shell Primitive | Best Fit | Structure & Guardrails |
| :--- | :--- | :--- | :--- |
| **1. Hairline Roster List** | `<List density="default\|compact">` + `<ListRow>` | Rules, configs, port mappings, scheduled triggers, workflow libraries, run histories, templates, narrow-panel item lists | `1px` bordered container + hairline dividers; sibling-slot a11y (`<button aria-pressed>` main trigger + always-visible `trailing` + hover/focus-revealed `actions` inside `@media (hover: hover)`, always visible on touch); collapses to single column at `@container (max-width: 680px)` and `@media (max-width: 680px)`. |
| **2. Object Card Grid** | `<CardGrid minWidth="sm\|md\|lg">` + `<SelectCard>` | Browsable asset and marketplace catalogs (Profiles, Model Providers, Plugins/Core Capabilities, Skills, Nodes) | Built-in `32x32` rounded `icon` box (string resolves via `HelmxIcon`), inline `badges`, 2-line clamped `description`, sibling `actions` and `footer`. Zero per-page card CSS clones. |
| **3. Grouped Triage Stage** | `<Screen toolbar>` + collapsible domain sections + SDK controls | Multi-dimension operational boards (exemplar: `ConversationOverview`) with status/dimension groups, bulk governance, and aggregate cards with sub-chips | Uses the unified `<Screen toolbar>` shell, `sm (28px)` filter controls, `sp.*` URL params, and SDK buttons/menus/badges. |
| **4. Structured Data Table** | `<DataTable loading empty columns label>` | **Only** multi-column horizontal numeric comparison and aligned scanning (quota matrices, ledgers, billing reports) | `--bg-subtle` header, `tabular-nums` numbers. **Hard rule**: narrow panels/drawers (`< 560px`) MUST NEVER exceed 3 columns—use `<List>` instead. |
| **5. Master-Detail / Full-Bleed Canvas** | `<Screen layout="full-bleed">` | Side-by-side Diff inspectors (`builtin:changes`), DAG/topology canvases, zoomable diagrams (`builtin:mermaid`), custom multi-pane workbenches | Edge-to-edge stage below the unified 46px topbar and optional sticky `toolbar`. |

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

1. **Full-Screen Stage (`Screen`)**: Topbar and toolbar locked to `sm (28px)`. Selecting or creating an item opens a right-side `<DetailDrawer>` (`520–560px` desktop, `100vw` at `<= 680px`) paired with `useScreenDrawer` for URL-hash and browser/mobile Back sync. Drawer forms use `md (32px)` fields, `Cmd/Ctrl + Enter` submit, dirty-state gating on edit, and a sticky footer: left `danger` delete (edit mode) + `<div className="flex-1" />` + `ghost` cancel + rightmost `primary` save.
2. **Narrow Side Panels (`workbenchPanel`, `settingsPanel`, drawer `slot`, `360–520px`)**: Use `sm (28px)` and `xs (22px)` controls only. Never render multi-column `<CardGrid>` or `> 3`-column `<DataTable>`; compose with `<KvGrid>`, `<List density="compact">`, and single-column `<Card variant="subtle">`. Never repeat a redundant top-level screen title.
3. **Timeline Inline Blocks (`toolView`, `timelineRenderer`, `json-render`)**: Follow Quiet Surface `26px` single-line traces with left chevron at `x=8px` (`6px` in `<= 450px` panes). Keep inline cards compact; on `replaceRow` cards, let the host IO panel handle input/output disclosure instead of rendering duplicate `ToolCallDetails`.
4. **Centered Modals (`Dialog` / `ConfirmDialog`)**: Width `440–560px`. Strictly limited to destructive confirmation, short forms (`<= 4` fields, e.g., Save Template or Install Plugin), single-credential entry, and media preview. Never cram catalogs, multi-dimensional search, or management lists into a modal.

## 6. Creative Zone Boundaries and CSS Hygiene

- **Where to express domain craft**: Inside `<Screen layout="full-bleed">` canvases (Diff viewers, DAGs, zoomable diagrams, charts) and domain micro-visuals inside cards or `ListRow` slots (`meta`, `leading`, `trailing`).
- **Zero private CSS by default**: Compose with SDK primitives and host tokens (`--space-1..6`, `--bg-*`, `--fg-*`, `--border`, `--radius-*`). Add a local `styles.css` only when host primitives do not cover a domain structure. Never copy host button/input/table/card CSS or edit `packages/web/src/styles.css` from a plugin.
- **Mandatory `:hover` gate**: Every `:hover` rule MUST sit inside `@media (hover: hover)` (enforced by `pnpm check:hygiene`). Any hover-revealed control MUST remain visible under `@media (hover: none)` or via `:focus-within`.
- **No bulk inline styles**: Avoid `style` objects except dynamic coordinates/dimensions; use SDK primitives (`Stack`, `Card`, `List`, `KvGrid`, `Field`) and tokens.

## 7. Pre-Delivery Checklist

- [ ] **Zero Emoji** across all UI copy, titles, icons, badges, and empty states.
- [ ] **Zero `variant="default"`** on `Button`/`IconButton`; at most **1 `primary`** per focus zone, placed rightmost.
- [ ] **Zero native `<select>`** and **zero `<input type="search">`**; zero hand-rolled absolute-positioned popovers or modals.
- [ ] **Exact height parity**: `md (32px)` in drawer/modal forms, `sm (28px)` in topbars/toolbars/narrow panels, `xs (22px)` for row micro-actions.
- [ ] **Single-layer `<Screen toolbar={<ScreenToolbar />}>`**: left switch/filter, right `SearchBox(variant="toolbar", size="sm")`; view-level Create/Refresh in `<Screen actions>` with `<span className="pane-action-label">`.
- [ ] **Right-side `DetailDrawer` + `useScreenDrawer`** for deep item inspection/editing; `ConfirmDialog(danger)` for irreversible deletes; `< 560px` panels have no `CardGrid` and `<= 3` `DataTable` columns.
- [ ] **CSS & runtime hygiene**: all `:hover` inside `@media (hover: hover)`, light + dark semantic tokens only, Fast Refresh compliant (`.tsx` exports components and types only), SSR `renderToString` safe.
- [ ] **Verification**: run `helmx plugins doctor <dir> --json` (external plugins) or `pnpm verify` / relevant unit & browser checks (in-repo).

> Canonical copy-pasteable JSX recipes: see `references/patterns.md` (when reading `.helmx/skills/helmx-ui`) or the **Canonical JSX Patterns** section below (when reading `helmx-cli` `references/ui-hig.md`).
