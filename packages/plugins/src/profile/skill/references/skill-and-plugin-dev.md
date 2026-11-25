# Skill and Plugin Bootstrap Development Reference

## Plugin source and build modes

Do not treat "development" and "build" as plugin enablement states. They describe where plugin code and frontend assets come from; a plugin can be enabled or disabled in either mode.

### Built-in plugins in the Helmx repository

- `pnpm dev` launches the Hub from TypeScript sources through `tsx` (`scripts/run-hub.mjs`); workspace mappings resolve `@helmx/plugins` to `packages/plugins/src`. Built-in UI clients therefore use their source `client/` directories and the host's runtime compiler.
- `pnpm build` builds package `dist/` output. The `@helmx/plugins` build also copies built-in `client/` assets and precompiles declared UI modules into `packages/plugins/dist/<plugin>/dist-client/`. The built-in asset resolver supports both source and built package locations.
- This is the repository's built-in plugin pipeline. `helmx plugins build` is not the command for building `@helmx/plugins` or the Hub.

### External plugins

External plugin backend entries remain plugin source files: TypeScript is transpiled and loaded by the Hub at runtime. `helmx plugins build` does **not** compile, package, or deploy that backend code.

The frontend has two modes:

| Mode | Source/artifact | When to use it |
| :--- | :--- | :--- |
| Runtime compilation | `clientRoot` source, compiled by the Hub's injected esbuild provider and cached by the host | Normal local development; edit source, run `doctor`, then `reload` the registered plugin as needed |
| Prebuilt client | Static `dist-client/` bundle with manifest and hashed modules, produced by `helmx plugins build` | Prepare a deployable frontend when the target host should not need runtime esbuild or frontend npm dependency installation |

Build and verify a prebuilt frontend locally:

```bash
helmx plugins doctor /absolute/path/to/my-plugin
helmx plugins build /absolute/path/to/my-plugin
```

By default, `build` writes `<plugin dir>/dist-client/`; `--out <dir>` selects another output location, which must be declared with `clientDist` in the plugin manifest/package Helmx metadata if it is not the conventional `dist-client/` directory. The Hub recognizes a valid conventional or declared prebuilt bundle and uses it instead of runtime compilation; it does not silently fall back to `clientRoot` when that prebuilt bundle is selected but invalid or stale. Rebuild after changing frontend source, and run `doctor` against the source before shipping. `build` is local and does not contact or update the Hub.

`doctor` validates source and performs real client compilation; it does not substitute for checking that a separately generated prebuilt directory is current. Keep `clientRoot` as the source of truth and distribute the intended `dist-client/` artifact with the plugin when using prebuilt mode.

## Bootstrapping skills (~/.helmx/skills/<id>/)

Skills are operation manuals the model loads on demand; keep SKILL.md short and put details in references/. All paths below live under the Hub data directory; when HELMX_DATA_DIR is configured, use that directory. Bash running on a remote node must not treat the local ~/.helmx as the Hub's asset directory.

```
~/.helmx/skills/deploy-playbook/
  SKILL.md              # required: frontmatter + index-level body
  references/
    rollback.md         # on-demand drill-down files (nested subdirs allowed)
    db-migrate.md
```

SKILL.md skeleton:

```markdown
---
name: deploy-playbook
description: Release process playbook (the model decides when to load by this sentence)
---

# Release Process

Read the reference files first when a scenario matches:

- references/rollback.md: rollback steps
- references/db-migrate.md: database migration
```

Key points:
- The id directory name must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}; paths inside references forbid absolute paths/`..`/backslashes/symlinks (strictly validated).
- The description decides triggering -- write it concretely and scenario-specific; keep details out of the body, let the index point the way.
- After writing, verify recognition with `helmx skills list` and readability with `helmx skills read <id>`.

## Developing external plugins (~/.helmx/installed-plugins/<dir>/)

Prefer `helmx plugins init <name>` to generate the full skeleton (incl. `plugin.json`, `index.ts`, `client/index.tsx`, `tsconfig.json`, and offline `.helmx/types/` declarations; run `helmx plugins types [dir]` anytime to write or refresh `.helmx/types/` for offline `tsc --noEmit` without modifying existing `tsconfig.json`); you can also hand-place a `plugin.json` declaring `{ "id": "my-plugin", "main": "index.ts", "clientRoot": "./client" }` or a conventional entry (`index.ts` / `index.mjs` / `index.js`). Runtime data lives separately in `ctx.dataDir` (`<dataDir>/plugins/<id>/`).

The server entry directly exports an object satisfying PluginDefinition, where definePlugin(ctx) registers capabilities; TypeScript works directly (the host transpiles and loads along the dependency closure):

```ts
// ~/.helmx/installed-plugins/my-plugin/index.ts
export default {
  id: "my-plugin",
  name: "My Plugin",
  version: "0.1.0",
  clientRoot: "./client", // required when frontend components live in client/ (default root is the plugin directory itself)
  definePlugin(ctx) {
    const state = ctx.doc("state", { count: 0 }, { public: true })
    ctx.action({
      id: "increment",
      description: "Increment the counter by one",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", properties: { count: { type: "number" } }, required: ["count"], additionalProperties: false },
      handler() {
        state.update(current => ({ count: current.count + 1 }))
        return state.get()
      },
    })
    ctx.ui.sidebarItem({ id: "my", label: "My Plugin", icon: "terminal", target: "screen:my-plugin/main" })
    // client.module resolves relative to clientRoot (here: <plugin dir>/client/index.tsx)
    ctx.ui.screen({
      id: "main", label: "Counter",
      client: { module: "index.tsx", export: "CounterScreen" },
    })
  },
}
```

client/index.tsx (shares the host React and SDK; never bundles a second React):

```tsx
import { usePluginContext, usePluginDoc } from '@helmx/plugin-client'

export function CounterScreen() {
  const { callAction } = usePluginContext()
  const state = usePluginDoc<{ count: number }>('state')
  return (
    <div className="card">
      <div>Count: {state?.count ?? 0}</div>
      <button type="button" className="btn btn-primary" onClick={() => void callAction('increment', {})}>+1</button>
    </div>
  )
}
```

Controlled frontend npm dependencies and plugin dependencies:

- client.tsx allows only `react`, `react-dom`, `lucide-react`, `@helmx/plugin-client`, and relative imports inside the plugin directory by default; third-party bare npm packages must be declared explicitly.
- Frontend dependencies can live in `plugin.json`:

```json
{
  "clientRoot": "./client",
  "clientDependencies": ["dayjs", "katex"]
}
```

  or in `package.json` under `helmx.clientDependencies`:

```json
{
  "dependencies": { "dayjs": "^1.11.0" },
  "helmx": { "clientDependencies": ["dayjs", "katex"] }
}
```

- `clientDependencies` is an exact bare-specifier whitelist for the frontend bundle; subpaths (e.g. `lodash/map`) must also be declared individually. The resolution root is pinned to the plugin's own directory; external plugin code cannot customize `npmDependencies` resolution roots.
- For managed installs, `helmx plugins install` / `helmx plugins update` install declared frontend dependencies with `--no-save`; also writing the package and version range into `package.json.dependencies` is recommended so installs stay reproducible. Bare package names without version ranges install per the package manager's current resolution.
- `helmx plugins doctor <dir>` and runtime client compilation share the same dependency boundary; missing dependencies, undeclared bare imports, and out-of-root relative paths fail explicitly -- never fake a pass with plain Markdown or empty components.
- Inter-plugin dependencies can be declared in `plugin.json.dependencies` or `package.json.helmx.dependencies`, e.g. `["base-plugin"]`; or in the entry export object's `dependencies` field (the three merge and dedup). It accepts plugin IDs only, not npm version ranges. Before enabling, depended-on plugins must be registered and enabled; dependency cycles are rejected; others disabling/uninstalling a plugin you depend on is blocked by `plugin_in_use`.
- A dependency declaration is not a calling mechanism; it only provides guarantees (the dependency exists, starts first, and cannot be pulled away). To actually invoke another plugin's features, use `ctx.host.invokeAction`:

```ts
// Depender: after declaring dependencies, safely call the other's actions at service start
export default {
  id: 'my-plugin',
  dependencies: ['base-plugin'],
  definePlugin(ctx) {
    ctx.service({
      id: 'worker',
      async start() {
        const result = await ctx.host.invokeAction(
          'base-plugin', 'analyze', { text: 'hello' },
        ) as { score: number }
        // The call passes the defense line: the target must be enabled (disabled errors
        // explicitly, never a silent empty return); input is validated by the target's
        // inputSchema, output by its outputSchema, uniformly redacted.
      },
      async stop() {},
    })
  },
}
```

- Dynamic discovery: `ctx.host.listActions()` returns all enabled plugins' action catalogs (pluginId / id / inputSchema / outputSchema / idempotent) for on-demand invocation; before calling, `ctx.host.prepareAction(pluginId, actionId, input)` does a side-effect-free precheck.
- Async communication goes through the event bus: publish with `await ctx.host.emitEvent('my-plugin:done', payload)` (others subscribe via `ctx.host.onEvent`; built-in host events in `HostEventMap` carry typed payload overloads, with a general `string` fallback for custom events); `onEvent` returns an unsubscribe function, and the host auto-unsubscribes on plugin disable.
- UI composition uses `ctx.ui.slot` to inject components into other plugins' named slots; on the frontend, read other plugins' public docs with `usePluginDoc(name, pluginId)` and invoke cross-plugin actions with `callAction(actionId, input, { pluginId })`.
- Never import another plugin's code directly: plugins are independent module graphs (supporting generational hot reload), and direct imports would weld two plugins' lifecycles together; cross-plugin interaction always goes through the interface-oriented channels `invokeAction` / `ctx.provide` & `ctx.consume` / events / slots.

Extension entries:
- Backend hooks ({{HOOK_COUNT}}): {{HOOK_NAMES}}; each hook's allowed continue/transform/handled/block results follow the protocol contract (only `input` allows `block`).
- Frontend {{UI_METHOD_COUNT}} ctx.ui registration methods: sidebarItem, screen, timelineRenderer, markdownCodeBlock, toolView, workbenchPanel, command, settingsPanel, slot (plugin child slots), and composerCompleter (input reference completion sources).
- timelineRenderer/markdownCodeBlock/toolView/composerCompleter support priority (adjudicated in descending order, default 0; ties keep contribution order); one plugin may declare multiple settings.panel blocks (ordered by `order`). markdownCodeBlock takes over Markdown code-block rendering by fence language (`languages`); without a registration hit it falls back to a plain code block. `toolView` components receive `ToolViewProps` where bounded UI replay metadata arrives on `props.presentationMeta` (`undefined` when absent; no `structuredOutput` or `siblingCalls`); read `props.presentationMeta` directly and fall back to `ToolCallDetails` or plain error `props.result` rather than parsing model text as JSON, and subscribe via `useTimelineToolCalls(toolName)` when peer calls in the same timeline are needed for folding or deduplication.
- `Profile.starters` are statically configured blank-conversation prompts, not a UI extension point; at most six per Profile, label at most 24 Unicode code points, prompt at most 4000 code points. They show only in a genuinely empty conversation with history fully loaded; clicking backfills the draft without sending; existing drafts, attachments, edits, or in-flight operations are never overwritten. CLI: `helmx profiles update <id> --starters '<json array>' --json`, pass `[]` to clear.
- `Profile.restrictToCwd` is a model-facing guardrail, not an OS sandbox: when enabled for a conversation's Profile, kernel file tools (read/write/edit/register_artifact) reject paths lexically escaping the conversation cwd (`path_outside_workspace`) and `agent_spawn` rejects explicit out-of-cwd request cwd values (plugin worktree rewrites via hooks are trusted); bash keeps its own OS-permission boundary. CLI: `helmx profiles update <id> --restrict-to-cwd` (or `--restrict-to-cwd=false` to disable).
- A command's slash (trigger word without /) also derives an input-box `/` completion: reserved words {{RESERVED_SLASH_COMMANDS}} and the skill: prefix are unclaimable, names must not collide across enabled plugins, and declaring slash requires binding to this plugin's actionId (use actionPluginId for cross-plugin actions).
- screen components receive params/setParams: in the URL hash, main-screen `sp.<key>` and split-screen `ssp.<key>` namespaces stay isolated, so two instances of the same screen never interfere; setParams replaces by default, `{push:true}` pushes onto the stack; components must not build their own routing or touch history directly.
- `composerCompleter` declares pure-data completion sources for `@ / # :` (`/` is reserved for commands/skills): `source` must explicitly pick `{kind:'action', actionId, actionPluginId?}` or `{kind:'doc'|'sessionDoc', name, itemsField}`. Action input `{query, conversationId?, profileId?}` (real conversations pass `conversationId`; standby-draft mode passes `profileId` or just `{query}` per the schema), output `{items:[{id,label,insertText,hint?,icon?}]}`, and must be `idempotent: true`; doc sources must be a top-level array field of this plugin's own public doc/sessionDoc -- never guess `docs[0]`. Completion replaces only the trigger token and inserts text only; it never submits/executes. The Web debounces queries; CLI/Agent/Workflow go through the same Action.
- `NODE_DETAIL_SECTION_SLOT` (`builtin:node/detail-section`) is a host-reserved slot in the node center, not a `builtin:node` plugin. Use `ctx.ui.slot` to inject into the existing-node extension area, Props being `{nodeId,isLocal,isOnline,isNew:false}`; pass no tokens/join commands, and do not mount on the new-node join form.
- `ctx.action({ id, description, inputSchema, outputSchema, visibility?, cli?, exposeAsTool?, presentationMetaSchema?, projectPresentationMeta?, idempotent?, scope?, promptSnippet?, promptGuidelines?, handler })` uniformly maps a Schema action onto HTTP, CLI, Workflow action(), the Web, and the conversation action catalog: enabled `public` actions matching the conversation's scope that are not directly exposed as tools automatically appear in the system prompt's `<available_actions>` catalog (fully-qualified ID/description/CLI command/compact signature; built-in and external plugins are equal; new plugins need no SYSTEM.md or built-in-skill changes); the model calls them directly via `run_action({ actionId, input })`, and `run_action({ actionId, describe: true })` read-only returns the full manifest (incl. nested schemas, without executing the handler, likewise filtered by enablement, visibility, and scope). `visibility` defaults to `'public'`; `'ui'` keeps HTTP / Web `callAction` (and `GET /api/actions` manifest for UI validation) and `ctx.host.invokeAction` while hiding from CLI / `<available_actions>` and rejecting `run_action` (execute & describe), Workflow DSL, and `exposeAsTool`; `'internal'` is restricted strictly to plugin-to-plugin `ctx.host.invokeAction` (omitted from `GET /api/actions`; rejects HTTP, `run_action`, Workflow DSL, `exposeAsTool`, and `composer.completer`), with the kernel stamping an unforgeable `context.callerPluginId` on `PluginActionContext` (caller-supplied values on `context` are ignored). `exposeAsTool: true | { name?, description?, replay?, formatOutput? }` derives a standalone model tool from the same single-point `ctx.action` declaration (not duplicated in `<available_actions>`; `name` sets an explicit provider-safe tool name instead of the hashed alias, `description` overrides model-facing copy, `replay: 'safe' | 'unsafe'` forwards cross-restart replay safety, `formatOutput(input, output)` formats model text while `handler` still returns the raw `outputSchema`-validated value, and `context.callId` carries the SDK tool call ID on the derived-tool path); `ctx.tool` is reserved for model-only tools outside the five-end mapping; both support `promptSnippet` (a full paragraph) / `promptGuidelines` (a bullet list): guidance injects only when actually activated, without duplicating the catalog; on disable or unreachable scope, the catalog, tools, and prompt fragments are cleaned automatically, leaving no phantoms. `idempotent: true` marks read-only/idempotent actions, allowing workflows to rerun them across broken chains after failure or interruption.
- Tool three-channel separation (`output` / `structuredOutput` / `presentationMeta`): `ctx.tool({ name, description, inputSchema, structuredOutputSchema?, presentationMetaSchema?, scope?, promptSnippet?, promptGuidelines?, execute })` separates model text from programmatic data and UI replay metadata. Returning a plain string goes to `output`; otherwise return an explicit `PluginToolResultEnvelope` (`{ output?, structuredOutput?, presentationMeta?, isError? }`): `output` (`string` or `Array<{ type: 'text', text: string }>`) is delivered to the model (32 KiB spill boundary); `structuredOutput` is machine-readable data for programmatic/nested callers (requires declaring `structuredOutputSchema`; SecretStash-redacted and schema-validated synchronously; never auto-mirrored to persisted `details` or model prompts); `presentationMeta` is a bounded plain JSON object persisted to `pi.tool-result.model[0].details` for UI/timeline replay (`ToolViewProps.presentationMeta` and `TimelineToolCallSummary.presentationMeta`; never enters model prompts or context usage) and requires declaring `presentationMetaSchema` (validated synchronously against `presentationMetaSchema` + SecretStash redaction + hard limits: 64 KiB UTF-8, depth 12, 2000 nodes; rejects prototype keys, non-enumerable/Symbol own keys, circular refs, sparse arrays, `undefined`, non-finite numbers, functions/BigInt; bare `details` in envelopes is explicitly rejected). For `ctx.action` with `exposeAsTool` enabled (`true` or `{ name?, description?, replay?, formatOutput? }`), `handler` keeps returning the naked business value validated against `outputSchema` (propagated as `structuredOutputSchema` on the derived tool, preserving five-end parity); optionally declare `formatOutput(input, output)` for concise redacted model text and `presentationMetaSchema` + pure `projectPresentationMeta(input, output)` to project bounded UI `presentationMeta` (registration rejects `presentationMetaSchema`/`projectPresentationMeta` when `exposeAsTool` is not enabled, or `projectPresentationMeta` without `presentationMetaSchema`).
- `ctx.host.execEnv(req, opts?)` executes commands across nodes via the kernel EnvFabric (reusing local / remote @helmx/node channels and redaction), tracked as in-flight tasks (withTask).
- `ctx.host.forkConversation(id, { entryId?, title? })` hot-forks a new conversation from a specified visible entry or, when `entryId` is omitted, from the latest clean anchor of the source conversation (automatically skipping trailing unclosed `toolCall`s; same source as `POST /api/conversations/:id/fork`, tracked as in-flight; a missing source conversation or entry throws 404, an invalid `entryId` 400, and empty completed non-system history 409 `fork_empty_history`). To derive a native sub-conversation from the parent conversation's currently completed history through the `agent_spawn` pipeline, pass `ctx.host.spawnAgent({ ..., fork: true })` (automatically avoiding unclosed toolCalls).
- `ctx.host.openTunnel(nodeId, target, signal?)` opens TCP (`{ host?, port }`) duplex streams to the target node via EnvFabric (the node resolves host, defaulting to `127.0.0.1`; active tunnels are tracked as in-flight). No companion plugin code is needed on the node side. `ctx.host.nodeIpc.listNodes()` returns a read-only snapshot (`NodeInfo[]`) of registered compute nodes without credentials or tokens (also permitted during `stopWindow`).
- `ctx.doc(name, initial, { public: true, durable? })` exposes global state (enters the global SSE first frame; updates broadcast in full; pass `durable: false` for in-memory transient state that skips SQLite and clears on disable/restart); frontend components subscribe via `usePluginDoc(name)`. Secret fields of `ctx.configSchema` go into credential storage, keeping them out of the public doc and `PluginSummary.publicConfig`; `ctx.getConfig()` merges schema defaults with persisted overrides and is guarded across `defining`, active, and `stopWindow` (throwing `409 plugin_context_closed` after disable/epoch advance). String fields may declare `format: 'model' | 'node' | 'profile'` to get a host-rendered standard picker (model catalog / compute node / Profile; stored values stay plain string ids; rendering rights always stay with the host -- plugins never ship their own form controls).
- `ctx.sessionDoc(name, initial, { public: true, durable? })` exposes state sharded per conversation (`durable: true` persists to SQLite; `durable: false` keeps transient state strictly in process memory and auto-clears on disable, conversation deletion, or restart): handles `get/set/update/delete(conversationId, ...)` (e.g. `metrics.update(input.conversationId, cur => ({ count: cur.count + 1 }))`); frontend components subscribe per current conversation with `usePluginSessionDoc("metrics")` or `usePluginSessionDocState("metrics")`; never enters the global first frame or global broadcast -- when public, a dedicated SSE (`GET /api/plugins/:id/docs/:name/events?conversationId=N`) pushes only to clients subscribed to that conversation; conversation deletion cascades cleanup, and writes after deletion are rejected. Session-scoped UI state (per-conversation task lists, run details) always uses sessionDoc instead of doc to avoid global write amplification; doc and sessionDoc must not share a name.
- `ctx.kv<T>(namespace)` provides lightweight per-plugin keyed KV storage backed by `state.sqlite` (`helmx_plugin_kv`) with `get(key)`, `set(key, value)`, `delete(key)`, `list({ prefix?, limit?, cursor? })`, `clear()`, and `flush()` (avoiding whole-namespace JSON serialization); `namespace` (`^[A-Za-z0-9._-]{1,64}$`) and `key` (1..256 printable chars) are validated at the boundary, values are SecretStash-redacted before persisting and bounded to 256 KiB UTF-8 per entry (`413 plugin_kv_too_large`), handles are epoch-guarded (with controlled `stopWindow` flush during `stop()`), retained across disable/enable, and purged on plugin uninstall.
- `ctx.provide<T>(capabilityId, impl)`, `ctx.consume<T>(capabilityId)`, and `ctx.onCapabilityChanged(capabilityId, listener)` form the typed inter-plugin (and kernel) capability registry: `capabilityId` is strictly validated (`^[a-z0-9][a-z0-9._-]{0,63}$`), `provide` returns an idempotent release function and auto-releases on disable/stop/rollback/uninstall, `consume` returns only active plugins' implementations (`ReadonlyArray<{ pluginId: string; impl: T }>`), and `ctx.onCapabilityChanged(capabilityId, listener)` notifies whenever active providers for `capabilityId` change (returning an idempotent unsubscribe callback and auto-releasing on disable/stop/rollback). Well-known contracts include `helmx.dispatch-tools` (collaboration dispatch tool names) and `helmx.model-tiers` (live model-tier resolution consumed by kernel `ModelRegistry`).
- `ctx.route({ method, path, public?, handler })` mounts raw Web Standard HTTP routes under `/api/plugins/<encodeURIComponent(pluginId)>/routes<path>`: supports `GET | POST | PUT | PATCH | DELETE | HEAD`, extracts percent-decoded `:param` segments into the 2nd argument `{ params }` (`handler(req, { params })`; static routes take precedence over parameterized ones, and duplicate/structurally colliding routes are rejected at registration with `400 validation_error`), tracks open streaming response bodies in `liveTasks` until EOF/cancel/abort, and automatically redacts `text/*` (incl. streaming `text/event-stream`), `application/x-ndjson`, and `application/json` / `*+json` (JSON-aware up to 4 MiB, streaming fallback above 4 MiB) responses through `SecretStash` while passing binary streams untouched without buffering. Frontend views call plugin routes with `usePluginContext().fetchRoute(path, init?)`. Tool names and public CLI action paths are also enforced unique at registration/enable commit (rejecting collisions against `KERNEL_TOOL_NAMES`, `CORE_CLI_COMMAND_PATHS`, or active plugins with `409 duplicate_tool_name` / `409 duplicate_cli_command`).
- `ctx.service({ id, start, stop })` manages background services; declaring liveTasks lets in-flight tasks be reported before disabling. Inside service.start you can bootstrap managed skills via `ctx.host.skills.ensureSkill({ id, skillMd, references })` (the standard home for long manuals -- do not stuff them into promptGuidelines):

```ts
const SKILL_MD = `---
name: deploy-guide
description: Deployment playbook (the model decides when to load by this sentence)
managedByPlugin: my-plugin
---

# Deployment
Read references/rollback.md first for rollback scenarios.
`

ctx.service({
  id: 'skill-bootstrap',
  async start() {
    await ctx.host.skills.ensureSkill({
      id: 'deploy-guide',
      skillMd: SKILL_MD,
      references: { 'rollback.md': '# Rollback\n...' },
    })
  },
  async stop() {},
})
```

  `managedByPlugin` must be this plugin's ID (the host validates the binding); the skill automatically leaves the available catalog when the plugin disables and returns on enable, while still being filtered by Profile.skills whitelists (catalog-limited Profiles must opt in explicitly) -- helmx-cli follows the same rule and is not always available.

Key points:
- External plugin ids forbid the `builtin:` prefix, forbid name collisions with registered plugins, and cannot self-declare locked; after placing into the directory, `helmx plugins rescan` discovers them incrementally (or a Hub restart auto-discovers), registered disabled by default.
- Managed installs: `helmx plugins install <source>` supports four sources -- `npm:<spec>`, `git:<repo>@<ref>`, HTTPS Git URLs, and local paths (resolved and fetched by the Hub server; a local path means a path on the Hub host; reinstalling the same canonical local directory hot-updates idempotently while preserving `ctx.doc` data and ensuring enabled unless `enable: false`); `helmx plugins update <id>` updates, `helmx plugins remove <id> [--yes]` removes (a destructive operation requiring confirmation; use --yes non-interactively); install records (PluginPackageRecord) are persisted by the installer, and PluginSummary carries optional managed metadata. Installing and enabling executes trusted plugin code inside the Hub process, with no sandbox -- install only trusted sources. The hand-managed directory route (init + rescan) remains available.
- Enable: `helmx plugins enable my-plugin`; after editing entry code use `helmx plugins reload my-plugin` for a controlled hot reload (static self-check precheck first; on failure the old instance stays untouched; no Hub restart needed). Disable/enable only rebuilds the lifecycle of existing definitions. Disabling or uninstalling with in-flight tasks is explicitly refused (409 plugin_has_live_tasks).
- Do not restart the Hub inside your own turn; finish delivering results first, then schedule the process restart.
- Frontend React components (client.tsx) compile dynamically via esbuild and may import react / react-dom / lucide-react / @helmx/plugin-client (host-shared instances; never bundle a second React). @helmx/plugin-client additionally shares the accessible foundation components: Switch, Select, MultiSelect, Checkbox, Tabs/TabsList/TabsTrigger/TabsContent, SegmentedControl, HelmxIcon, ViewBoundary, Callout, Dialog/DialogPortal/DialogOverlay/DialogContent/DialogTitle/DialogDescription/DialogClose/DialogTrigger, Popover/PopoverTrigger/PopoverContent/PopoverClose, Tooltip/TooltipProvider/TooltipRoot/TooltipTrigger/TooltipContent, DropdownMenu/DropdownMenuRoot/DropdownMenuTrigger/DropdownMenuPortal/DropdownMenuContent/DropdownMenuItem/DropdownMenuSeparator/DropdownMenuLabel/DropdownMenuGroup, AlertDialog/AlertDialogPortal/AlertDialogOverlay/AlertDialogContent/AlertDialogTitle/AlertDialogDescription/AlertDialogAction/AlertDialogCancel/AlertDialogTrigger (confirm dialogs) plus the high-level ConfirmDialog (double-confirm composition with danger variant and pending state), SearchBox (unified container-class search input with the single clear button; always type="text"), EmptyState (host .empty-state vocabulary with optional icon/title/hint/compact), LoadingState (unified `.loading-state` + `.spin-slow` loading indicator), MarkdownView, MarkdownText, CodeBlockView, CopyButton, ToolCallDetails (read-only tool-call detail body: raw input/output code blocks plus artifact open button via ctx.openArtifact, reusing the host trace vocabulary), PluginSlot, PluginScope (layout-transparent `display: contents` anchor stamping `data-plugin-id` for custom plugin subtrees/portals), StatusLight (unified status light: visually dot-only for card main status slots; accepts either explicit `tone: StatusLightTone` + required `label`/`aria-label` or raw `status: string`; exports `STATUS_LIGHT_TONES`, `normalizeStatusLightTone`, and `isKnownStatusLightStatus` from the root `@helmx/plugin-client` entry — never import `@helmx/plugin-client/pure` from plugins), core form and display primitives Button / IconButton (typed variants/sizes, `pending` busy state, `forwardRef` compatible with Radix `asChild`), Badge (`neutral | accent | ok | warn | err`, `icon`, `mono`), Stack (flex direction/gap mapped to `--space-1..5` without inline styles), Input / Textarea (size/mono/invalid + automatic FieldContext wiring), Field / HelperText / ErrorText (non-wrapping `<label htmlFor>` or `htmlFor={false}` `role="group"` + FieldContext propagation to Input/Textarea/Select/MultiSelect/Switch/Checkbox), Card (static container with `elevated | subtle` and `default | warn | danger`), SelectCard + CardGrid (stage-grid selectable card using sibling trigger + actions slots and narrow-pane-safe `minmax(min(100%, ...), 1fr)` grid), MonoId (truncating monospace identifier pill + integrated CopyButton), plus the lightweight layout primitives Screen (page container + header with `layout?: 'contained' | 'full-bleed'`), ScreenSection (sectioning), DataTable (composable table shell with unified loading/empty; thead/rows expressed as children JSX), KvGrid (items: Array<{key,value}> key-value overview), ScreenToolbar (header-to-content toolbar row: children main area + right-aligned actions + label to aria-label, reusing the host .screen-toolbar common classes), DetailDrawer (right-side detail drawer shell over the shared .primary-drawer-* CSS vocabulary: open/onClose controlled, title + titleExtra badges + optional icon/meta lines, composable body and footer; empty/loading states stay caller JSX), DockTray / DockTrayRow (shared composer-dock in-flight activity HUD tray and expandable row primitives over the shared .dock-tray* CSS vocabulary), and the generic formatting pure functions formatTime (MM-DD HH:mm), formatCompactTimestamp (MM-DD HH:mm:ss), formatDurationMs (millisecond duration summary), formatStopwatchMs (1Hz whole-second stopwatch Xs / XmYYs / XhYYm), formatOffsetMs (relative offset +MM:SS / +H:MM:SS), resolveConversationTiming (honest conversation timing snapshot over status/runDurationMs/runStartedAt/pendingAskSince/nowMs), formatBytes (human-readable bytes, base 1024) -- prefer reusing these primitives and formatters for common structures instead of building native controls, duplicate formatters, or new CSS themes. ModelPickerControl is the shared model + thinking-level picker (the exact control the host composer / standby / profile / plugin-config forms use; reads the catalog via the useHostModels host port slice; row body click applies the model with a null level so thinking follows the server-authoritative default chain, level chips commit model + level together, `showThinkingLevels={false}` renders plain model-id picking for config fields, display copy arrives via the `copy` prop with English SDK defaults) with the model display helpers formatModelShortName and resolveEffectiveThinkingLevel (thinking-level convergence against a model's supported list) plus usePanelShortcut (panel-scoped listener for host `helmx:shortcut` events such as `toggle-model-picker` / `toggle-plan-mode`, matched against the element's enclosing `[data-helmx-panel]`) -- prefer reusing these primitives and formatters for common structures instead of building native controls, duplicate formatters, or new CSS themes.
- Shared hooks: usePluginLocale() resolves the active `en` / `zh-CN` UI locale; usePluginTranslator() returns a stable translator for localized display copy; usePluginAction() wraps `ctx.callAction` with synchronous re-entrancy mutex, `pending`/`pendingKey`/`error`/`clearError`, optional `notifyError`, and unmount guard; useToolActivity(callId, active) reports background tool activity of the owning timeline turn; useTimelineToolCalls(toolName) subscribes reactively to lightweight chronological TimelineToolCallSummary snapshots ({ callId, toolName, index, status, input?, presentationMeta? }, omitting bulky result/resultTruncation/structuredOutput) sharded by toolName within the enclosing timeline (TimelineToolCallsContext) -- unrelated toolName updates never trigger re-renders, unchanged shards keep referential stability, and outside a timeline Provider (or with an empty toolName / SSR) it returns a shared frozen empty array; useComposerCommand(commandId, handler) registers a composer-local handler for a plugin's `CommandSpec` inside Composer / AgentStandbyPane slots so slash picks and exact submissions execute interactively without raw RPCs or one-off protocol fields; usePluginDocState<T>(name, pluginId?) reactively subscribes to a public global doc with honest three-state `{ data, status: 'loading' | 'ready' | 'error', error?, retry }` (cross-plugin addressing supported) and usePluginDoc<T>(name, pluginId?) is its thin value wrapper; usePluginSessionDocState<T>(name, conversationIdOrOptions?) subscribes to a public session doc per conversation (accepts a numeric `conversationId` or `{ conversationId?, pluginId? }`, returning `{ data, status, error?, retry }`; multi-component shared subscription; unsubscribes at zero references; first-frame restore on reconnect; `retry()` reconnects after errors) and usePluginSessionDoc<T>(name, {conversationId?, pluginId?}?) is its thin value wrapper; useConversations() for all conversation summaries; useConversation(id) for a single conversation's live view (summary/detail/live/pendingAsks); usePlugins() for a reactive snapshot of the host plugin list and Screen contributions (plugins + screens, live-synced via SSE -- app-center-style views use it to sense installed apps and their main views' enablement); usePluginConfig<T>() for the current plugin's reactive non-secret configuration (`PluginSummary.publicConfig`, excluding all `secret: true` fields; returns `{}` when unset; usable inside `<PluginUiView>`); useHostModels() for the host's normalized read-only model catalog slice (stable host-port subscription isolated from host streaming churn: `HostModelEntry` list with per-model thinking levels plus the global default chain -- `undefined` means the capability is not injected or the catalog has not finished its first load, render unknown/loading and disable selection; a slice with `models: []` means loaded and genuinely empty, the two are strictly distinct; dynamic refresh is only the optional `refreshModels` port action, absent means the host offers no refresh -- hide the entry, surface `errors` verbatim when present); useHostNodes() for the host's read-only compute node list slice (`HostNodesSlice | undefined`, never exposing node tokens) and useHostProfiles() for the host's read-only Profile catalog slice (`HostProfilesSlice | undefined`, excluding `SYSTEM.md` bodies), both using the same isolated host-port subscription and honest `undefined` (not injected / initial load incomplete) vs `[]` (loaded and empty) semantics; useScreenParams() for the screen-local params scope provided by the host ScreenHost (returns null outside a plugin screen -- honest absence, never a fake no-op scope; params/setParams bind the owning pane's URL-hash-backed scope so the hash stays the single source of truth, and isSplit reports the split-pane context); useSharedNowMs() for the shared coarse-grained current timestamp (ticks cleanly for relative durations without per-component timers); <PluginSlot name> declares child slots; usePluginContext() provides callAction(actionId, input, {pluginId?, conversationId?}) (cross-plugin capable), fetchRoute(path, init?) (authenticated fetch scoped to `/api/plugins/<encodeURIComponent(pluginId)>/routes<path>` where the host injects the Bearer token without exposing it to plugin code; `path` must start with `/` and stay inside this plugin's route namespace, returning raw `Response` untouched for JSON, binary, `FormData`, or SSE streams), submitInput(text, {conversationId?, whenBusy?}), openScreen/openSplitScreen/openConversationDrawer/openArtifact/openWorkbench(panelId?, params?) (auto-qualifies local `panelId` to `plugin:<pluginId>/<panelId>` while keeping `'artifacts'`/`'files'`/`'plugin:...'`, and passes transient `params` to `WorkbenchPanelProps.params`), notify, and more.
- Plugin view styles live in a local .css inside clientRoot (imported; esbuild merges it into the preserved export __helmxClientCss, with the host managing injection, zero-specificity `:where([data-plugin-id="<pluginId>"])` scoping synchronized across `<PluginScope>` and SDK portals, and reclamation); never write the host's styles.css.
- UI copy strictly forbids Emoji; icons use lucide icon names.
- For the complete extension points and the client.tsx single-track mechanism, see the in-repo docs/architecture/extension-points.md and docs/plugins/plugin-development.md.
- When client.tsx involves heavy dependencies, dynamic imports, first-screen performance, or async chunks, read `references/plugin-client-code-splitting.md` first; that manual specifies the source shape the AI should write, the host bridging internals that must never be touched, verification commands, and failure handling.
