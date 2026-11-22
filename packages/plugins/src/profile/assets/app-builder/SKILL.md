---
name: {{SKILL_ID}}
description: Use when building reusable full-stack micro-apps (tool desks, boards, reconciliation desks, trackers with frontend, backend, and persistent state) as standard screen-bearing Helmx plugins; covers L1 ephemeral cards vs L2 full-stack apps selection, directory conventions, the doctor/install SOP, and code templates.
managedByPlugin: {{MANAGED_BY}}
---

# Building Full-Stack Micro-Apps (Screen-Bearing Plugins)

When the user needs a tool that is "reusable, with its own UI and persistent data", deliver it as a standard screen-bearing external Helmx plugin per this skill's SOP. Installed micro-apps are managed and launched directly from **Plugin Center** (filtered under **With views** / **应用视图**, with one-click **Open view** and **Open in split**).

## L1 or L2: choose first

- **L1 ephemeral card (```ui code block)**: data tables, metrics, and confirmation forms shown once inside the current conversation; they sink with the conversation, with no persistent state and no backend logic. See the `generative-ui` skill (`load_skill({ skillId: "generative-ui" })`) when available in this turn's skill catalog.
- **L2 full-stack micro-app (this skill)**: tool desks the user explicitly wants to "save/install/open again later", or that need cross-conversation persistent data, custom backend actions, or a standalone UI. The artifact is a standard Helmx plugin package declaring at least one `ctx.ui.screen`, installed via `helmx plugins install`.

When unsure, ask the user one question; do not guess for them.

## L2 Delivery SOP (four steps, no skipping)

### 1. Planning and directory initialization

Scaffold directly with the CLI (or create under `<cwd>/apps/<app-id>/`):

```bash
helmx plugins init <app-id> --dir <parentDir> --template app --json
```

Directory layout:

```
<parentDir>/<app-id>/
  plugin.json          # { "id": "<app-id>", "main": "index.ts", "clientRoot": "./client" }
  index.ts             # backend: clientRoot: "./client" + ctx.doc / ctx.action / ctx.ui.screen
  tsconfig.json        # local typecheck config
  client/index.tsx     # frontend: main Screen component (zero private stylesheet by default)
```

- `app-id` uses kebab-case (e.g. `bill-desk`); the `builtin:` prefix and colons (`:`) are forbidden;
- **clientRoot is required**: when frontend components live in a `client/` subdirectory, `index.ts`'s `PluginDefinition` (and `plugin.json`) must declare `clientRoot: './client'` explicitly -- when undeclared the default root is the plugin directory itself, and `helmx plugins doctor` fails with a missing client module because it cannot find `index.tsx`;
- UI copy and icons follow the zero-Emoji iron rule; icons use lucide icon names (e.g. `layout-grid`, `list-checks`, `wallet`).

### 2. Full-stack coding constraints and the shared SDK

Backend `index.ts` (a standard `PluginDefinition`):

- `ctx.doc('<name>', initialState, { public: true })` persists global data; use `ctx.sessionDoc('<name>', initialState, { public: true })` for per-conversation state; **`await doc.flush()` after writes**;
- `ctx.action({ id, description, inputSchema, outputSchema, idempotent?, exposeAsTool: true, handler })`: actions must declare **both `inputSchema` and `outputSchema`** (read-only actions use `idempotent: true`); the handler may call `ctx.host.execEnv` to run commands across nodes; actions automatically get the HTTP / CLI / Agent Tool / Workflow / Web five-end mapping;
- **You must register at least one `ctx.ui.screen({ id: 'main', label: '...', client: { module: 'index.tsx', export: 'MainScreen' } })`** -- this is what turns the plugin into an openable micro-app in Plugin Center (under the **With views** tab);
- `ctx.ui.sidebarItem` is optional: omit or remove it unless the user explicitly asks for a permanent left-sidebar shortcut (Plugin Center already exposes **Open view** and **Open in split** for every active screen-bearing plugin, preventing sidebar bloat).

Frontend `client/index.tsx` (host shared SDK, import directly without installing):

- **The only allowed runtime bare imports are host shared modules**: `react`, `react-dom`, `lucide-react`, `@helmx/plugin-client`; types may use `import type ... from '@helmx/protocol'`. For third-party npm packages, declare each one in `plugin.json.clientDependencies` or `package.json.helmx.clientDependencies` first, then state the version range in `package.json.dependencies`; otherwise `helmx plugins doctor` fails explicitly on undeclared bare dependencies.
- **The `@helmx/plugin-client` shared export list**:
  - **Reactive hooks**: `usePluginContext()` (provides `callAction` / `submitInput` / `openScreen` / `openSplitScreen` / `openConversationDrawer` / `openArtifact` / `openWorkbench` / `notify`), `usePluginDoc(name, pluginId?)`, `usePluginSessionDoc(name, opts?)`, `useConversations()`, `useConversation(id)`, `usePlugins()`, `useScreenParams()`, `usePluginAction()`, `usePluginLocale()`, `usePluginTranslator()`, `useToolActivity(callId, active)`;
  - **Page layout primitives (prefer these over hand-rolled page scaffolding)**: `Screen` (fullscreen container + standard page header `title/subtitle/actions`), `ScreenSection` (section container `title/titleExtra`), `ScreenToolbar` (toolbar row), `DataTable` (composable table shell with unified `loading/empty` placeholders; `thead/tbody` expressed as JSX), `KvGrid` (`items: [{ key, value }]` key-value grid), `DetailDrawer` (right slide-over drawer);
  - **Accessible controls and content components**: `HelmxIcon`, `Switch`, `Select`, `MultiSelect`, `Checkbox`, `Tabs / TabsList / TabsTrigger / TabsContent`, `SegmentedControl`, `Dialog / DialogTrigger / DialogContent / DialogTitle / DialogDescription / DialogClose`, `AlertDialog` / `ConfirmDialog`, `SearchBox`, `EmptyState`, `LoadingState`, `StatusLight`, `Callout`, `MarkdownView`, `MarkdownText`, `CodeBlockView`, `CopyButton`, `ViewBoundary`, `PluginSlot`;
- Styling defaults to zero private CSS: compose layout with SDK primitives (`Screen` header `actions`, `ScreenSection` `titleExtra`, `DataTable`, `KvGrid`) and host public classes (`.input`, `.btn btn-primary`, `.stack-row`, `.loading-state`, `.callout`); add a scoped `client/styles.css` (bundled via `import './styles.css'`) only when the host vocabulary is genuinely insufficient, limit it to your own class names, and keep colors on host CSS variables (`var(--bg-elevated)`, `var(--border)` etc.) to stay dark/light adaptive; never write the host's `styles.css`;
- Component files export only components and types (Fast Refresh); the `module` path and named `export` referenced by `client` must match reality (`helmx plugins doctor` validates compiled artifact exports).

Full runnable template: `load_skill({ skillId: "app-builder", path: "references/fullstack-template.md" })`; for advanced extension points (backend lifecycle hooks, `composerCompleter`, workbench panels, etc.), consult `load_skill({ skillId: "helmx-cli", path: "references/skill-and-plugin-dev.md" })` on demand.

### 3. Mandatory static self-check (Zero-Broken-App)

After writing or modifying code you **must** run:

```bash
helmx plugins doctor <absDir> --json
```

Verify BOTH conditions in the JSON output:
1. `ok === true` (zero failed checks across `manifest` -> `backend` -> `register` -> `client`);
2. `screens` is non-empty (e.g. `["main"]` -- confirming at least one `ctx.ui.screen` registered cleanly).

- When `ok: false` or `screens` is empty, fix every failing item on the spot (TS types, schemas, missing `ctx.ui.screen`, or React export mismatches) and re-run `helmx plugins doctor <absDir> --json` until passing;
- **Never skip doctor and deliver anyway**; never fabricate check results.

### 4. Install / hot-update or deliver as draft

- **Install or upgrade immediately** (when the user wants it usable right away or wants to iterate on an existing app):
  ```bash
  helmx plugins install <absDir> --enable --json
  ```
  - First install copies the plugin into the Hub's managed plugin directory, registers it, and enables it.
  - **Idempotent local-directory hot update**: re-running `helmx plugins install <absDir> --enable` (or `helmx plugins install <absDir>`) from the **same canonical local source directory** atomically hot-updates the installed plugin in place, **preserves existing `ctx.doc` data**, and ensures it is enabled. (Installing a *different* source directory with the same plugin ID is honestly rejected with `409 plugin_package_already_installed`.)
  - Verify the installed summary reports `enabled: true` and `enableError` is absent.
  - On success, if `generative-ui` is available you may output a ```ui delivery card with "Open side-by-side in right split" (`{ "type": "helmx:open", "target": "screen:<appId>/main", "split": true }`) and "Open in Plugin Center" (`{ "type": "helmx:open", "target": "plugins:<appId>" }`) buttons; otherwise give the user clear navigation instructions (Plugin Center -> **With views** -> **Open view**).
- **Review first (draft mode)**: when the user asks to inspect the code before installing, stop after `helmx plugins doctor <absDir> --json` passes, summarize the plugin's docs/actions/screens and source directory, and tell the user they can install it via `helmx plugins install <absDir> --enable` or Plugin Center -> **Install plugin**.
- **Uninstall**: `helmx plugins remove <appId> --yes` (deletes the Hub's managed copy and persisted docs; local workspace source directory is untouched).

## Boundary facts (tell the user honestly)

- **No sandbox**: installed plugins are in-process trusted code running inside the Hub with full host privileges (they can read/write files and execute across nodes); only install code from trusted sources;
- **Path boundary**: `helmx plugins doctor <absDir>` and `helmx plugins install <absDir>` resolve local directories on the **Hub host filesystem** (local node), not on a remote node; when a conversation runs on a remote node, state this boundary honestly rather than guessing a Hub path;
- **Managed copy, not symlink**: `helmx plugins install <absDir>` copies source files into `<dataDir>/installed-plugins/<appId>`. After editing the workspace source, re-run `helmx plugins install <absDir> --enable` (or `helmx plugins update <appId>`) to sync changes.
