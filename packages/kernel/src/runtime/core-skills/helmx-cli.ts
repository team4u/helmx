/**
 * Kernel-owned `helmx-cli` managed skill (`managedByPlugin: core:host`).
 *
 * Layer 1 (SKILL.md): helmx CLI golden rules, core command landscape, and references drill-down index.
 * Layer 2 (references/*.md): skill/plugin development manual and client.tsx code-splitting manual,
 * loaded on demand via `load_skill({ skillId: "helmx-cli", path })`.
 *
 * Stored as compiled TypeScript modules inside `@helmx/kernel` so `tsc -b`, incremental
 * `pruneDist`, and `@helmx/payload` (`kernel.tgz`) ship the assets uniformly across dev and dist.
 */
import {
  PLUGIN_HOOK_NAMES,
  PLUGIN_UI_METHOD_NAMES,
  RESERVED_SLASH_COMMANDS,
} from '@helmx/protocol'
import type { BuiltinSkillAsset } from '../../services/skill-service.js'
import { renderSkillTemplate } from './template.js'
import { HELMX_CLI_UI_HIG_MD } from './ui-hig.js'

export const HELMX_CLI_SKILL_ID = 'helmx-cli'
export const HELMX_CLI_SKILL_OWNER = 'core:host'

const HELMX_CLI_SKILL_TEMPLATE = `---
name: {{SKILL_ID}}
description: "Host governance via core:* actions (core:models, core:nodes, core:plugins, core:asks), CLI-only operations (plugins install/update/remove/init/types/build, nodes issue, providers/credentials, auth, env exec, conversations watch, events watch, nodes forward, helmx api, Hub lifecycle), terminal/script CLI reference, and plugin/skill development. Inside Agent turns always prefer run_action over shell CLI when an action exists; load conversations or profiles skills for conversation recall and Profile management."
managedByPlugin: {{MANAGED_BY}}
---

# Helmx Host Governance & CLI Quick Reference

## Environment and CLI ground rules

1. **Action-first inside Agent turns (never shell out when an action exists)**: inside Agent turns, NEVER shell out to \`helmx\` via \`bash\` whenever an equivalent \`core:*\` or plugin action exists — call \`run_action\` directly instead (strict JSON Schema validation, structured JSON output, and built-in kernel ownership/self-mutation guards). Discover available actions live via \`run_action({ list: true, pluginId: "core:" })\` (core host actions) or \`run_action({ list: true, pluginId: "builtin:" })\` (built-in plugin actions), and inspect exact schemas read-only via \`run_action({ actionId, describe: true })\`. Reserve \`helmx\` CLI in \`bash\` strictly for CLI-only operations without an action (such as \`plugins install/update/remove/init/types/build\`, \`nodes issue\`, \`nodes forward\`, \`providers/*\`, \`credentials/*\`, \`auth/*\`, \`env exec\`, \`conversations watch\`, \`events watch\`, \`helmx api\`, or Hub lifecycle) or when writing terminal/script commands for the user.
2. The Helmx-managed \`bash\` provides the \`helmx\` CLI (PATH-first) and the session environment; usually you can call it directly without manual login:
   - \`HELMX_ENV\` (fixed to \`1\`, marking a Helmx-managed execution environment).
   - \`HELMX_HUB_URL\`: the Hub address; \`HELMX_TOKEN\`: the managed process token (never print it or write it into prompts). Troubleshoot by the actual error when a call fails.
   - \`HELMX_CONVERSATION_ID\`: the current conversation ID; \`HELMX_CWD\`: the session working directory; \`HELMX_NODE_ID\`: the bound node (with an extra \`HELMX_DATA_DIR\` when local).
   - \`HELMX_EXECUTION_SCOPE\`: a stable resource namespace for the current Helmx instance, conversation, node, and working directory. Repeated commands under the same execution coordinate reuse it; it changes after switching conversation, node, or working directory. When external tools support named sessions or resource isolation, you may name them explicitly with it. The variable does not configure external tools automatically, nor does it provide a process or file sandbox.
3. Always add \`--json\` when consuming CLI output programmatically (human-readable output is for display only, not programmatic consumption).
4. Commands that support \`--current\` use it to select the current conversation (reads \`HELMX_CONVERSATION_ID\`); other commands take the target ID per their help.
5. Self-introspection first (do not memorize volatile details): inside Agent turns, trust the in-session \`<available_actions>\` catalog, live discovery via \`run_action({ list: true, pluginId?: "<pluginId>" })\` (trailing \`:\` such as \`"core:"\` or \`"builtin:"\` matches by prefix), read-only schema introspection via \`run_action({ actionId, describe: true })\`, and \`core:plugins.config_get\` for plugin config. From a terminal or external script (or for CLI-only commands), query subcommand arguments live with \`helmx --help\`, \`helmx <cmd> --help\`, \`helmx actions list --json\`, and \`helmx plugins config <id> --json\`.
6. When the conversation is busy, \`helmx send\` supports \`--when-busy steer|followUp|reject\` (default steer when omitted); when an AskDoc is pending, \`--when-pending-ask supersede|reject\` controls whether human input supersedes it (default supersede) or fails \`409 ask_pending\`; add \`--wait\` to wait for the reply.

## Core Actions & CLI command landscape (API and CLI on equal footing, all support --json)

### Auth and status (CLI-only)
- **CLI-only (\`action: false\`)**: \`auth.*\` operations are never exposed as \`core:*\` actions; run from a terminal or when explicitly invoking CLI-only diagnostics.
- \`helmx status\`: auth status plus local Hub snapshot (probing works even when unconfigured or offline).
- \`helmx doctor\`: read-only diagnostics across data dir, local Hub, Hub reachability/auth, configured models, and nodes.
- \`helmx setup [--password <pwd>]\`: initialize the admin password and log in (first time only; prompts masked in TTY or reads stdin when omitted).
- \`helmx login [--password <pwd>]\`: log in and save credentials to cli-token (prompts masked in TTY or reads stdin when omitted).

### Local Hub maintenance (CLI-only)
- **CLI-only (no in-session action)**: \`helmx start [-d] [--channel <tag>] [--port <n>] ...\` starts the local Hub: installs the payload first when nothing is committed, then runs it in the foreground (Ctrl+C stops it via the verified control channel); \`-d\` runs detached in the background writing \`hub.pid\`. \`helmx stop\` stops gracefully (control channel first, pid identity proof fallback), \`helmx restart\` stops then starts detached. \`helmx update --check [--channel <tag>] --json\` checks the local Hub release and \`helmx update\` applies it (installs when nothing is committed). \`helmx service <install|uninstall|status>\` manages the OS startup service (launchd / systemd --user / schtasks) running \`helmx start\` in the foreground. Run lifecycle commands from a local terminal or service manager outside any Helmx turn; foreground \`helmx start\` streams human-readable progress.

### Conversations
- **In-session turns (Action-first)**: load the \`conversations\` skill and call \`core:conversations.*\` (\`search\`, \`list\`, \`get\`, \`entry\`, \`create\`, \`update\`, \`send\`, \`withdraw\`, \`abort\`, \`reset\`, \`compact\`, \`fork\`, \`delete\`) via \`run_action\` instead of shelling out to the CLI commands below. Reserve CLI strictly for terminal/script reference and CLI-only commands (\`helmx conversations watch\`, \`helmx events watch\`, \`helmx conversations file\`, \`helmx ask\`, bulk \`helmx conversations delete\`).
- \`helmx conversations list [--profile <id>] [--status <s>] [--tag <t>] [--owned-by human|helmx] [--top-level | --all | --parent <id>]\`: top-level human conversations only by default (noise reduction); \`--owned-by helmx\` lists top-level automated sessions; \`--tag <t>\` matches tagged conversations regardless of ownership; \`--top-level\` explicitly enforces top-level filtering (\`--top-level=false\` includes child conversations); \`--all\` includes all derived sub-conversations and automated sessions; \`--parent <id>\` lists exactly one conversation's direct children (mutually exclusive with --all and --top-level).
- \`helmx conversations get [id] [--current] [--limit N | --turns N] [--cursor <c>]\` (with a paginated timeline; \`--limit\` \`1..500\` or \`--turns\` \`1..50\`, mutually exclusive)
- \`helmx conversations entry [id] <entryId> [--current]\` (full text of a single timeline entry; detail pagination truncates head/tail of very long plain-text tool-results, and this command returns the untruncated original)
- \`helmx conversations file [id] <path> [--current] [--output <path>]\` (CLI-only: read a file strictly inside the conversation's bound workspace on the target node; text files are redacted via SecretStash, binary files require \`--output\`)
- \`helmx conversations create [--title <t>] [--profile-id <id>] [--node <nodeId>] [--cwd <dir>] [--model <m>] [--tags <t>] [--parent-conversation-id <id>]\`
- \`helmx conversations update <id> --title/--model/--thinking/--profile-id/--node/--cwd/--tags/--pinned/--unread\`
- \`helmx conversations reset [id] [--current] [--handoff <text>]\` (reset context; handoff becomes the first message)
- \`helmx conversations compact [id] [--current] [--instructions <text>]\` / \`helmx conversations fork [id] [--current] [--entry-id <n>] [--title <t>]\` / \`helmx conversations delete [id...] [--current]\` (bulk delete goes through one request; deleting a conversation cascades its derived child conversations; per-item failures such as \`conversation_managed_by_plugin\` are reported in \`failures\` with exit code 1; deleting the conversation executing the command in a managed turn is rejected with \`self_delete_forbidden\`)
- \`helmx send <id> "<text>"\` or \`helmx send --current "<text>"\`: submit input; supports \`--wait\`, \`--when-busy steer|followUp|reject\` (default steer when omitted), \`--when-pending-ask supersede|reject\` (default supersede when omitted), \`--meta <json>\`, \`--attach <artifactIds>\`, \`--replace-from <entryId>\` (resend overwriting from the given history entry, truncating that entry and everything after); use \`--origin agent\` when sending on an agent's behalf.
- \`helmx ask "<text>"\`: CLI-only one-shot Q&A (internally creates a conversation and waits for the answer; stdout prints only the answer text by default, \`--json\` outputs \`{conversationId,submissionId,entryId,answer,deleted}\`); piped stdin content (non-TTY) merges into the prompt automatically; \`--profile/--node/--title/--cwd/--model/--tags/--timeout <ms>/--delete-on-success\`; on failure the conversation is kept and the error envelope carries a queryable conversationId.
- \`helmx conversations withdraw [id] [--current] --submission-id <n>\`: withdraw a queued input (returns already_placed/settled honestly when execution started or it already settled).
- \`helmx conversations watch <id> [--timeout <ms>] [--quiet]\`: CLI-only blocking watch until that conversation's current turn settles (done/idle -> exit 0, error -> exit 1, \`--timeout\` -> exit 124); live doing/status lines from the global SSE, \`--quiet\` prints only the final line, \`--json\` emits NDJSON progress plus a final \`result\` object — chain shell steps on the exit code. No \`--current\`, and never watch the conversation whose turn executes the command (circular wait): inside a managed turn, watching your own conversation id is rejected with \`self_watch_forbidden\` — watch subagents or other conversations by explicit id.
- \`helmx abort [id] [--current]\`: abort the current turn; never abort the turn you are currently executing.
- \`helmx events watch\`: CLI-only global SSE event stream (runs continuously; end with Ctrl+C).
- \`helmx search <query> [--profile <id>] [--owned-by human|helmx] [--top-level] [--limit <n>] [--max-per-conversation <1..20>]\`: full-text search across conversations (FTS5), optionally filtered by profile, ownership, top-level conversations only, result limit (\`1..100\`), and per-conversation hit cap (\`1..20\`).

### Profiles and skills
- **In-session turns (Action-first)**: for Profile management, load the \`profiles\` skill and call \`core:profiles.*\` (\`list\`, \`get\`, \`create\`, \`update\`, \`delete\`) via \`run_action\` instead of shelling out to \`helmx profiles ...\`. For skills, \`core:skills.list\` and \`core:skills.read\` are scope-blocked inside conversations — always use the \`load_skill\` tool in-session; \`helmx skills list\` / \`helmx skills read\` are for terminal/script reference only.
- \`helmx profiles list\` / \`helmx profiles get <id>\`
- \`helmx profiles create [id] --name/--model/--thinking/--node/--cwd/--tags/--restrict-to-cwd/--system[-file]/--skills/--all-skills/--starters/--input <json>\` (extension capabilities follow the current turn's plugin actions and skill catalog)
- \`helmx profiles update <id> ...\`: supports the same semantic flags (incl. \`--restrict-to-cwd\` / \`--restrict-to-cwd=false\`) via GET-then-merge-PUT (bound fields are not lost); \`--input\` alone is a full replacement.
- \`helmx profiles delete <id>\` (the default assistant cannot be deleted).
- \`helmx skills list\` / \`helmx skills read <id> [--path references/xxx.md]\`: Hub global catalog by default. \`--current\` scopes to the current conversation workspace (reads HELMX_CONVERSATION_ID and resolves the conversation's real nodeId/cwd from the Hub first — never trust a locally guessed cwd), while \`--node <id> [--cwd <dir>]\` targets any registered node (standalone \`--node\` merges the node's machine-level \`~/.helmx/skills\` + \`~/.agents/skills\`; optional \`--cwd\` adds \`<cwd>/.helmx/skills\`; \`--cwd\` requires \`--node\`, both mutually exclusive with --current). Scoped results merge read-only node skills with the same-name priority Hub > ~/.agents/skills (Hub) > node ~/.helmx/skills > node ~/.agents/skills > workspace \`.helmx/skills\` (the Hub version always wins); shadowed node skill ids and node-scan diagnostics are reported explicitly, unregistered/offline nodes and invalid coordinates fail with explicit errors, and nothing is silently dropped. The built-in helmx-cli is a system-managed read-only skill, overwritten from built-in sources at startup; to extend it, create your own skill instead of modifying built-in files.

### Models and gateways
- **In-session \`run_action\` (\`core:models.*\`, Action-first)**: use \`core:models.list\` (catalog, thinking levels & defaults), \`core:models.providers\` (sanitized provider summaries; no plaintext secrets), \`core:models.refresh\` (refresh dynamic catalogs), \`core:models.default_get\` (read global/per-model defaults), \`core:models.default\` (update defaults), and \`core:models.filter\` (set/clear disabled models). Inspect exact schemas with \`run_action({ actionId: "core:models.<id>", describe: true })\`.
- **CLI-only (\`action: false\`, security red line)**: \`providers.*\` (\`helmx providers list/set\`) and \`credentials.*\` (\`helmx credentials list/set/delete\`) are never exposed as \`core:*\` actions — manage custom gateways and credentials via terminal/HTTP only.
- **Terminal/script CLI reference**:
  - \`helmx models list\` / \`helmx models default [--set <provider/model>] [--thinking <level>] [--model-thinking <provider/model=level>] [--compaction <provider/model>] [--compaction-thinking <level>]\` / \`helmx models providers\` / \`helmx models refresh [--provider <id>] [--providers <list>] [--force]\` / \`helmx models filter [--provider <id> [--disable <modelId>... | --clear]]\` (model disable set: view without arguments; full-replacement semantics; \`--model-thinking\` sets per-model thinking defaults — empty level like \`provider/model=\` clears that model's entry).
  - \`helmx providers list\` / \`helmx providers set --input <json>\` (CLI-only; replaces the gateway array wholesale; secrets strictly forbidden).
  - \`helmx credentials list\` / \`helmx credentials set <id> [--value <value>]\` / \`helmx credentials delete <id>\`: CLI-only server-side credential management (\`set\` prompts masked in a TTY or reads stdin when \`--value\` is omitted).

### Nodes and cross-machine execution
- **In-session \`run_action\` (\`core:nodes.*\`, Action-first)**: read-only queries use \`core:nodes.list\`, \`core:nodes.endpoints\`, \`core:nodes.upgrade_check\`, \`core:nodes.forwards\`, and \`core:nodes.forward_inspect\`. Host-governance mutations (top-level \`ownedBy: "human"\` conversation only) use \`core:nodes.upgrade\`, \`core:nodes.remove\`, and \`core:nodes.forward_stop\`. Inspect exact schemas with \`run_action({ actionId: "core:nodes.<id>", describe: true })\`.
- **CLI-only (no in-session action)**: \`nodes.issue\` (\`helmx nodes issue\`, one-time plaintext join token; \`action: false\`), \`helmx nodes forward\` (foreground Hub-host TCP listener), and \`helmx env exec\` (direct cross-node command execution).
- **Terminal/script CLI reference**:
  - \`helmx nodes list\`: nodes, online status, versions, and health snapshot; \`helmx nodes endpoints\`: Hub listen summary and reachable enrollment URLs; \`helmx nodes issue <nodeId> [--hub <url>]\` (CLI-only): issue a join token (the plaintext is returned exactly once with a copy-pasteable \`helmx-node start -d\` command; omit \`--hub\` for server auto-selection or pass an explicit http(s) URL); \`helmx nodes remove <nodeId>\`; \`helmx nodes upgrade <nodeId> [--check]\`: check or perform a node upgrade; \`helmx nodes forward [<nodeId> | --current] <[listenHost:]listenPort> <[targetHost:]targetPort>\` (CLI-only): foreground Hub-host TCP port forwarding (listener binds on the Hub host, bare \`listenPort\` defaults to \`127.0.0.1\`; Ctrl-C exits and closes); \`helmx nodes forwards\` / \`helmx nodes forward-inspect <forwardId>\` / \`helmx nodes forward-stop <forwardId>\`: active forward list/detail/stop.
  - Remote machines join as nodes with a one-time npm install of the node daemon (\`npm install -g @helmx/node\`) followed by \`helmx-node start -d --hub <url> --token <nodeId>:<secret>\`; later versions arrive via \`helmx nodes upgrade\` (the daemon upgrades the \`@helmx/node\` npm artifact).
  - \`helmx env exec [--node <id>] [--cwd <dir>] [--timeout <ms>] [--stream] [--current] -- <command...>\` (CLI-only): execute a command directly across nodes; the timeout unit is milliseconds.

### Plugins and actions
- **In-session \`run_action\` (\`core:plugins.*\`, Action-first)**: read-only queries use \`core:plugins.list\`, \`core:plugins.manifest\`, \`core:plugins.doc\` (point-in-time global/session public doc read), \`core:plugins.config_get\` (masked config & schema; no secrets), and \`core:plugins.doctor\` (static dry-run self-check). Host-governance mutations (top-level \`ownedBy: "human"\` conversation only) use \`core:plugins.config_set\`, \`core:plugins.enable\`, \`core:plugins.disable\`, \`core:plugins.reload\`, and \`core:plugins.rescan\`. Inspect exact schemas with \`run_action({ actionId: "core:plugins.<id>", describe: true })\`.
- **CLI-only (no in-session action)**: \`helmx plugins install\`, \`helmx plugins update\`, and \`helmx plugins remove\` (managed package lifecycle, \`action: false\`), local scaffolding/build commands \`helmx plugins init\`, \`helmx plugins types\`, and \`helmx plugins build\` (touch no Hub), \`helmx plugins client\`, and continuous \`helmx plugins doc ... --watch\`.
- **Terminal/script CLI reference**:
  - \`helmx plugins list\` (incl. status: active|disabled|failed with failure diagnostics) / \`helmx plugins manifest <id>\` (read-only extension contract projection: hooks, actions, tools, UI contributions, routes, public doc descriptors, config field schema without secrets, providers, services, client modules) / \`helmx plugins enable <id>\` / \`helmx plugins disable <id> [--force]\` (when the occupancy precheck returns 409 plugin_in_use, \`--force\` can force it; in-flight running tasks still cannot be skipped) / \`helmx plugins config <id> [--input <json>] [--set k=v] [--unset <key>]\` (\`--unset\` sends null to remove an explicit override; repeatable; conflicts with \`--set\` on the same key error out) / \`helmx plugins client <id>\` (CLI-only).
  - \`helmx plugins doctor <id|dir>\`: static self-check of external plugin source (real-generation imports + real registration assertions + real client compilation and dangling-export validation); pick one target: an absolute directory path or a registered plugin id; failed precheck items are listed one by one, never silently.
  - \`helmx plugins reload <id>\`: controlled hot-reload of an external plugin (doctor precheck first; on failure the old instance stays untouched; in-flight tasks reject with 409; enablement state is kept).
  - \`helmx plugins rescan\`: incrementally rescan the plugins directory (registers only new external plugins, disabled by default).
  - \`helmx plugins init [name] [--dir <parent-dir>] [--template minimal|full|app] [--force]\` (CLI-only): scaffold an external plugin skeleton locally (\`full\` by default: plugin.json + index.ts + tsconfig.json + client/index.tsx + \`.helmx/types/\`; \`minimal\` is backend-only; \`app\` adds a \`ctx.ui.screen\` main view for full-stack micro-apps); touches no Hub.
  - \`helmx plugins types [dir] [--dir <dir>]\` (CLI-only): write or refresh local \`.helmx/types/\` TypeScript declaration snapshots (\`@helmx/protocol\`, \`@helmx/protocol/browser\`, \`@helmx/plugin-client\`, plus standalone shims) for offline IDE/\`tsc --noEmit\` checking without modifying existing \`tsconfig.json\`; touches no Hub.
  - \`helmx plugins build [dir] [--out <dir>]\` (CLI-only): precompile a plugin directory's frontend modules into static \`dist-client/\` artifacts locally (zero runtime esbuild / npm dependency install required on target hosts); touches no Hub.
  - Plugin source/runtime modes are separate from enablement and reload. For the distinction between Hub source development, built-in package builds, external plugin backend loading, runtime client compilation, and prebuilt \`dist-client\` artifacts, read \`references/skill-and-plugin-dev.md\` before choosing a build or verification command.
  - \`helmx plugins install <source> [--enable]\` (CLI-only): install an external plugin package from \`npm:<spec>\`, \`git:<repo>@<ref>\`, an HTTPS Git URL, or a local path and register it (disabled by default; \`--enable\` enables right after install). Re-running \`install\` on the same canonical local directory performs an idempotent hot update (preserving existing \`ctx.doc\` data and ensuring enabled unless \`enable: false\`); installing a different source with an existing plugin ID rejects with \`409 plugin_package_already_installed\`. The source is resolved and fetched by the Hub server (a local path is a path on the Hub host, not a client upload); installing and enabling executes trusted plugin code inside the Hub process, with no sandbox.
  - \`helmx plugins update [<id>] [--all] [--source <source>]\` (CLI-only): update one managed external plugin package (optionally switching/upgrading to \`--source <source>\` while preserving plugin data) or \`--all\` managed packages sequentially, and reload when files changed (\`changed:false\` skips reload when unchanged).
  - \`helmx plugins remove <id> [--yes]\` (CLI-only): remove a managed installed external plugin package (destructive: disables and cleans the installation directory and records on the Hub host). Human-mode TTY requires typing yes; use \`--yes\` in non-interactive environments; \`--json\` is non-interactive.
  - \`helmx plugins doc <id> <name>\`: read a global public doc (in-session use \`core:plugins.doc\`); add \`--conversation <n>\` (or \`--current\`) for session docs, and \`--watch\` (CLI-only) for continuous subscription (a dedicated SSE whose first frame is the current value; Ctrl-C exits).
- Action discovery defers to the current turn's catalog and tool list: the system prompt's \`<available_actions>\` section lists plugin actions that are currently enabled, match this conversation's scope, and are invoked via \`run_action\`; directly exposed actions appear in the model tool list. Built-in and external plugins are equal; new plugins appear automatically without touching SYSTEM.md or built-in skills. Each catalog entry carries the fully-qualified ID (\`pluginId.actionId\`), description, equivalent terminal CLI command, and a compact parameter signature, plus optional author-declared guidance; entries disappear automatically when a plugin is disabled or an action is unreachable.
- The catalog is a summary, not the full contract: inside Agent turns, use \`run_action({ list: true, pluginId?: "<pluginId>" })\` (supports exact IDs as well as namespace prefixes ending with \`:\`, e.g. \`pluginId: "core:"\` or \`pluginId: "builtin:"\`) to dynamically list all active, scope-allowed public actions (including actions omitted from \`<available_actions>\` via \`exposeToPrompt: false\`, along with their CLI commands), and \`run_action({ actionId: "<pluginId>.<actionId>", describe: true })\` to read one action's complete manifest (incl. nested input/output JSON Schemas) without executing the handler or side effects; both are filtered by enablement and scope, so sessions without bash can still discover and introspect. From a terminal or shell script (outside Agent turns), use \`helmx actions list --json\` (full catalog) or \`helmx <plugin> <action> --help\` (single-action arguments).
- \`run_action({ actionId, input })\` can call public scope-allowed actions directly without reading this skill first; actions with \`exposeAsTool: true\` additionally appear in the tool list as standalone tools with equivalent calling semantics.
- \`helmx <plugin> <action>\` (terminal/script CLI mapping): enabled plugin actions (both built-in and external) map automatically to top-level CLI namespaces (stripping the \`builtin:\` prefix; \`cli.command\` can override; e.g. \`helmx my-plugin send_notice\`), with \`--input <json>\` for parameters. Inside Agent turns, call \`run_action({ actionId, input })\` instead of shelling out; from a terminal/script, discover namespaces via \`helmx actions list --json\` and inspect flags via \`helmx <plugin> <action> --help\`.

### Approvals, artifacts, and the escape hatch
- **In-session \`run_action\` (\`core:asks.*\`, Action-first)**: use \`core:asks.list\` to inspect AskDoc approval requests and \`core:asks.cancel\` (top-level \`ownedBy: "human"\` conversation only) to cancel a pending ask. \`core:asks.answer\` is human HTTP/CLI only (scope-blocked inside all conversations — never call it in-session).
- **CLI-only**: \`helmx asks answer\` (human-only), \`helmx artifacts list/put/get\` (in-session artifact delivery uses \`write(..., artifact: true)\`, \`register_artifact\`, and \`read_artifact\`), and \`helmx api\` (raw HTTP escape hatch).
- \`helmx asks list [--conversation <id> | --current] [--status pending|answered|cancelled|superseded]\` / \`helmx asks answer <id> --answers <json> [--expected-state-seq <n>]\` (human-only; CAS optimistic lock) / \`helmx asks cancel <id>\`.
- \`helmx artifacts list [id] [--current]\` / \`helmx artifacts put <filePath> [id] [--name <n>] [--mime-type <m>]\` / \`helmx artifacts get <id> [--output <path>]\`.
- When generating text files for the user to view in the Web, use \`write(..., artifact: true)\`. To register an existing file (incl. images, videos, PDFs), use \`register_artifact({ path: "<path>" })\`: the path resolves relative to the current conversation's cwd, is read on the conversation's bound node, and is copied into the Hub's artifact directory; delivery counts as successful only after the artifact ID returns. Single artifacts are capped at 15 MiB.
- In a terminal, use \`helmx artifacts put <path> --current\` to upload a local file on the calling machine; relative paths resolve against that CLI process's actual cwd -- \`--current\` only selects the conversation and never changes where files are read from. \`helmx artifacts get <id> --output <path>\` likewise writes on the calling machine and echoes the actual absolute path on success. Never treat a Hub or another node's path as a local path.
- When an external command generates a file to deliver, use a filename or directory unique to this task and pass an absolute output path based on the actual execution directory; in a POSIX shell you can do \`output="$PWD/report-<task-identifier>.png"\` first. When explicitly choosing another directory, confirm it exists on the actual execution node. \`HELMX_CWD\` is the managed session directory; after \`cd\` in a shell, \`$PWD\` may differ from it.
- After generation, confirm the expected file exists, then register it with the same absolute path; a zero exit code or "saved successfully" output is no substitute for artifact registration. On read failure, investigate by the absolute path and node in the error; never auto-search other sessions' worktrees or mistake an old same-name file for this task's artifact.
- Artifact registration stores an independent copy; files to deliver must be registered before cleaning the source worktree. After success, inline-render them in the reply with \`[filename](artifact:<id>)\` or \`![image](artifact:<id>)\`. Cleaning the worktree does not delete these copies; deleting the owning conversation cascades to its artifacts.
- \`helmx api <METHOD> <path> [--input <json>] [--field k=v]\` (CLI-only): raw HTTP escape hatch (e.g. \`helmx api GET /api/nodes\`).

## Topic manuals on demand

When a matching topic comes up, read the reference file before acting:
- Before bootstrapping a new skill (~/.helmx/skills/<id>/SKILL.md) or developing an external plugin (~/.helmx/installed-plugins/<id>/):
  \`load_skill({ skillId: "helmx-cli", path: "references/skill-and-plugin-dev.md" })\`.
- Before writing or modifying any plugin UI (\`client/*.tsx\`, \`Screen\`, \`DetailDrawer\`, \`workbenchPanel\`, \`settingsPanel\`, \`toolView\`, or \`slot\`):
  \`load_skill({ skillId: "helmx-cli", path: "references/ui-hig.md" })\`.
- Before developing or optimizing a plugin's client.tsx, especially involving heavy dependencies, dynamic imports, first-load performance, or async chunks:
  \`load_skill({ skillId: "helmx-cli", path: "references/plugin-client-code-splitting.md" })\`.
- Interactive displays, micro-app building, and other extension capabilities: choose per the current turn's available skill descriptions -- load the applicable skill first, then follow its guidance to call tools or actions from \`<available_actions>\`; with no applicable skill, use plain Markdown and never reference manuals outside the catalog.
`

const SKILL_AND_PLUGIN_DEV_TEMPLATE = `# Skill and Plugin Bootstrap Development Reference

## Plugin source and build modes

Do not treat "development" and "build" as plugin enablement states. They describe where plugin code and frontend assets come from; a plugin can be enabled or disabled in either mode.

### Built-in plugins in the Helmx repository

- \`pnpm dev\` launches the Hub from TypeScript sources through \`tsx\` (\`scripts/run-hub.mjs\`); workspace mappings resolve \`@helmx/plugins\` to \`packages/plugins/src\`. Built-in UI clients therefore use their source \`client/\` directories and the host's runtime compiler.
- \`pnpm build\` builds package \`dist/\` output. The \`@helmx/plugins\` build also copies built-in \`client/\` assets and precompiles declared UI modules into \`packages/plugins/dist/<plugin>/dist-client/\`. The built-in asset resolver supports both source and built package locations.
- This is the repository's built-in plugin pipeline. \`helmx plugins build\` is not the command for building \`@helmx/plugins\` or the Hub.

### External plugins

External plugin backend entries remain plugin source files: TypeScript is transpiled and loaded by the Hub at runtime. \`helmx plugins build\` does **not** compile, package, or deploy that backend code.

The frontend has two modes:

| Mode | Source/artifact | When to use it |
| :--- | :--- | :--- |
| Runtime compilation | \`clientRoot\` source, compiled by the Hub's injected esbuild provider and cached by the host | Normal local development; edit source, run \`doctor\`, then \`reload\` the registered plugin as needed |
| Prebuilt client | Static \`dist-client/\` bundle with manifest and hashed modules, produced by \`helmx plugins build\` | Prepare a deployable frontend when the target host should not need runtime esbuild or frontend npm dependency installation |

Build and verify a prebuilt frontend locally:

\`\`\`bash
helmx plugins doctor /absolute/path/to/my-plugin
helmx plugins build /absolute/path/to/my-plugin
\`\`\`

By default, \`build\` writes \`<plugin dir>/dist-client/\`; \`--out <dir>\` selects another output location, which must be declared with \`clientDist\` in the plugin manifest/package Helmx metadata if it is not the conventional \`dist-client/\` directory. The Hub recognizes a valid conventional or declared prebuilt bundle and uses it instead of runtime compilation; it does not silently fall back to \`clientRoot\` when that prebuilt bundle is selected but invalid or stale. Rebuild after changing frontend source, and run \`doctor\` against the source before shipping. \`build\` is local and does not contact or update the Hub.

\`doctor\` validates source and performs real client compilation; it does not substitute for checking that a separately generated prebuilt directory is current. Keep \`clientRoot\` as the source of truth and distribute the intended \`dist-client/\` artifact with the plugin when using prebuilt mode.

## Bootstrapping skills (~/.helmx/skills/<id>/)

Skills are operation manuals the model loads on demand; keep SKILL.md short and put details in references/. All paths below live under the Hub data directory; when HELMX_DATA_DIR is configured, use that directory. Bash running on a remote node must not treat the local ~/.helmx as the Hub's asset directory.

\`\`\`
~/.helmx/skills/deploy-playbook/
  SKILL.md              # required: frontmatter + index-level body
  references/
    rollback.md         # on-demand drill-down files (nested subdirs allowed)
    db-migrate.md
\`\`\`

SKILL.md skeleton:

\`\`\`markdown
---
name: deploy-playbook
description: Release process playbook (the model decides when to load by this sentence)
---

# Release Process

Read the reference files first when a scenario matches:

- references/rollback.md: rollback steps
- references/db-migrate.md: database migration
\`\`\`

Key points:
- The id directory name must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}; paths inside references forbid absolute paths/\`..\`/backslashes/symlinks (strictly validated).
- The description decides triggering -- write it concretely and scenario-specific; keep details out of the body, let the index point the way.
- After writing, verify recognition with \`helmx skills list\` and readability with \`helmx skills read <id>\`.

## Developing external plugins (~/.helmx/installed-plugins/<dir>/)

Prefer \`helmx plugins init <name>\` to generate the full skeleton (incl. \`plugin.json\`, \`index.ts\`, \`client/index.tsx\`, \`tsconfig.json\`, and offline \`.helmx/types/\` declarations; run \`helmx plugins types [dir]\` anytime to write or refresh \`.helmx/types/\` for offline \`tsc --noEmit\` without modifying existing \`tsconfig.json\`); you can also hand-place a \`plugin.json\` declaring \`{ "id": "my-plugin", "main": "index.ts", "clientRoot": "./client" }\` or a conventional entry (\`index.ts\` / \`index.mjs\` / \`index.js\`). Runtime data lives separately in \`ctx.dataDir\` (\`<dataDir>/plugins/<id>/\`).

The server entry directly exports an object satisfying PluginDefinition, where definePlugin(ctx) registers capabilities; TypeScript works directly (the host transpiles and loads along the dependency closure):

\`\`\`ts
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
\`\`\`

client/index.tsx (shares the host React and SDK; never bundles a second React; always read \`references/ui-hig.md\` before authoring UI):

\`\`\`tsx
import { useState, type ReactNode } from 'react'
import { Button, Card, Screen, Stack, usePluginContext, usePluginDoc } from '@helmx/plugin-client'

export function CounterScreen(): ReactNode {
  const { callAction } = usePluginContext()
  const state = usePluginDoc<{ count: number }>('state')
  const [pending, setPending] = useState(false)

  const handleIncrement = async (): Promise<void> => {
    setPending(true)
    try {
      await callAction('increment', {})
    } finally {
      setPending(false)
    }
  }

  return (
    <Screen layout="contained" title="Counter">
      <Card title="Counter">
        <Stack direction="horizontal" align="center" justify="between" gap="md">
          <span className="tabular-nums">Count: {state?.count ?? 0}</span>
          <Button variant="primary" size="sm" icon="plus" pending={pending} onClick={() => void handleIncrement()}>
            Increment
          </Button>
        </Stack>
      </Card>
    </Screen>
  )
}
\`\`\`

Controlled frontend npm dependencies and plugin dependencies:

- client.tsx allows only \`react\`, \`react-dom\`, \`lucide-react\`, \`@helmx/plugin-client\`, and relative imports inside the plugin directory by default; third-party bare npm packages must be declared explicitly.
- Frontend dependencies can live in \`plugin.json\`:

\`\`\`json
{
  "clientRoot": "./client",
  "clientDependencies": ["dayjs", "katex"]
}
\`\`\`

  or in \`package.json\` under \`helmx.clientDependencies\`:

\`\`\`json
{
  "dependencies": { "dayjs": "^1.11.0" },
  "helmx": { "clientDependencies": ["dayjs", "katex"] }
}
\`\`\`

- \`clientDependencies\` is an exact bare-specifier whitelist for the frontend bundle; subpaths (e.g. \`lodash/map\`) must also be declared individually. The resolution root is pinned to the plugin's own directory; external plugin code cannot customize \`npmDependencies\` resolution roots.
- For managed installs, \`helmx plugins install\` / \`helmx plugins update\` install declared frontend dependencies with \`--no-save\`; also writing the package and version range into \`package.json.dependencies\` is recommended so installs stay reproducible. Bare package names without version ranges install per the package manager's current resolution.
- \`helmx plugins doctor <dir>\` and runtime client compilation share the same dependency boundary; missing dependencies, undeclared bare imports, and out-of-root relative paths fail explicitly -- never fake a pass with plain Markdown or empty components.
- Inter-plugin dependencies can be declared in \`plugin.json.dependencies\` or \`package.json.helmx.dependencies\`, e.g. \`["base-plugin"]\`; or in the entry export object's \`dependencies\` field (the three merge and dedup). It accepts plugin IDs only, not npm version ranges. Before enabling, depended-on plugins must be registered and enabled; dependency cycles are rejected; others disabling/uninstalling a plugin you depend on is blocked by \`plugin_in_use\`.
- A dependency declaration is not a calling mechanism; it only provides guarantees (the dependency exists, starts first, and cannot be pulled away). To actually invoke another plugin's features, use \`ctx.host.invokeAction\`:

\`\`\`ts
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
\`\`\`

- Dynamic discovery: \`ctx.host.listActions()\` returns all enabled plugins' action catalogs (pluginId / id / inputSchema / outputSchema / idempotent) for on-demand invocation; before calling, \`ctx.host.prepareAction(pluginId, actionId, input)\` does a side-effect-free precheck.
- Async communication goes through the event bus: publish with \`await ctx.host.emitEvent('my-plugin:done', payload)\` (others subscribe via \`ctx.host.onEvent\`; built-in host events in \`HostEventMap\` carry typed payload overloads, with a general \`string\` fallback for custom events); \`onEvent\` returns an unsubscribe function, and the host auto-unsubscribes on plugin disable.
- UI composition uses \`ctx.ui.slot\` to inject components into other plugins' named slots; on the frontend, read other plugins' public docs with \`usePluginDoc(name, pluginId)\` and invoke cross-plugin actions with \`callAction(actionId, input, { pluginId })\`.
- Never import another plugin's code directly: plugins are independent module graphs (supporting generational hot reload), and direct imports would weld two plugins' lifecycles together; cross-plugin interaction always goes through the interface-oriented channels \`invokeAction\` / \`ctx.provide\` & \`ctx.consume\` / events / slots.

Extension entries:
- Backend hooks ({{HOOK_COUNT}}): {{HOOK_NAMES}}; each hook's allowed continue/transform/handled/block results follow the protocol contract (only \`input\` allows \`block\`).
- Frontend {{UI_METHOD_COUNT}} ctx.ui registration methods: sidebarItem, screen, timelineRenderer, markdownCodeBlock, toolView, workbenchPanel, command, settingsPanel, slot (plugin child slots), and composerCompleter (input reference completion sources).
- timelineRenderer/markdownCodeBlock/toolView/composerCompleter support priority (adjudicated in descending order, default 0; ties keep contribution order); one plugin may declare multiple settings.panel blocks (ordered by \`order\`). markdownCodeBlock takes over Markdown code-block rendering by fence language (\`languages\`); without a registration hit it falls back to a plain code block. \`toolView\` components receive \`ToolViewProps\` where bounded UI replay metadata arrives on \`props.presentationMeta\` (\`undefined\` when absent; no \`structuredOutput\` or \`siblingCalls\`); read \`props.presentationMeta\` directly and fall back to \`ToolCallDetails\` or plain error \`props.result\` rather than parsing model text as JSON, and subscribe via \`useTimelineToolCalls(toolName)\` when peer calls in the same timeline are needed for folding or deduplication.
- \`Profile.starters\` are statically configured blank-conversation prompts, not a UI extension point; at most six per Profile, label at most 24 Unicode code points, prompt at most 4000 code points. They show only in a genuinely empty conversation with history fully loaded; clicking backfills the draft without sending; existing drafts, attachments, edits, or in-flight operations are never overwritten. CLI: \`helmx profiles update <id> --starters '<json array>' --json\`, pass \`[]\` to clear.
- \`Profile.restrictToCwd\` is a model-facing guardrail, not an OS sandbox: when enabled for a conversation's Profile, kernel file tools (read/write/edit/register_artifact) reject paths lexically escaping the conversation cwd (\`path_outside_workspace\`) and \`agent_spawn\` rejects explicit out-of-cwd request cwd values (plugin worktree rewrites via hooks are trusted); bash keeps its own OS-permission boundary. CLI: \`helmx profiles update <id> --restrict-to-cwd\` (or \`--restrict-to-cwd=false\` to disable).
- A command's slash (trigger word without /) also derives an input-box \`/\` completion: reserved words {{RESERVED_SLASH_COMMANDS}} and the skill: prefix are unclaimable, names must not collide across enabled plugins, and declaring slash requires binding to this plugin's actionId (use actionPluginId for cross-plugin actions).
- screen components receive params/setParams: in the URL hash, main-screen \`sp.<key>\` and split-screen \`ssp.<key>\` namespaces stay isolated, so two instances of the same screen never interfere; setParams replaces by default, \`{push:true}\` pushes onto the stack; components must not build their own routing or touch history directly. For right-side \`DetailDrawer\` navigation inside screens, prefer the shared \`useScreenDrawer\` hook (pairs directly with \`DetailDrawer\`: closed->open passes \`{push:true}\`, switch/close omits it, stale deep links handled cleanly via \`hasItem\`, and unhosted views fall back to local state).
- \`composerCompleter\` declares pure-data completion sources for \`@ / # :\` (\`/\` is reserved for commands/skills): \`source\` must explicitly pick \`{kind:'action', actionId, actionPluginId?}\` or \`{kind:'doc'|'sessionDoc', name, itemsField}\`. Action input \`{query, conversationId?, profileId?}\` (real conversations pass \`conversationId\`; standby-draft mode passes \`profileId\` or just \`{query}\` per the schema), output \`{items:[{id,label,insertText,hint?,icon?}]}\`, and must be \`idempotent: true\`; doc sources must be a top-level array field of this plugin's own public doc/sessionDoc -- never guess \`docs[0]\`. Completion replaces only the trigger token and inserts text only; it never submits/executes. The Web debounces queries; CLI/Agent/Workflow go through the same Action.
- \`NODE_DETAIL_SECTION_SLOT\` (\`builtin:node/detail-section\`) is a host-reserved slot in the node center, not a \`builtin:node\` plugin. Use \`ctx.ui.slot\` to inject into the existing-node extension area, Props being \`{nodeId,isLocal,isOnline,isNew:false}\`; pass no tokens/join commands, and do not mount on the new-node join form.
- \`ctx.action({ id, description, inputSchema, outputSchema, visibility?, cli?, exposeAsTool?, presentationMetaSchema?, projectPresentationMeta?, idempotent?, scope?, promptSnippet?, promptGuidelines?, handler })\` uniformly maps a Schema action onto HTTP, CLI, Workflow action(), the Web, and the conversation action catalog: enabled \`public\` actions matching the conversation's scope that are not directly exposed as tools automatically appear in the system prompt's \`<available_actions>\` catalog (fully-qualified ID/description/CLI command/compact signature; built-in and external plugins are equal; new plugins need no SYSTEM.md or built-in-skill changes); the model calls them directly via \`run_action({ actionId, input })\`, and \`run_action({ actionId, describe: true })\` read-only returns the full manifest (incl. nested schemas, without executing the handler, likewise filtered by enablement, visibility, and scope). \`visibility\` defaults to \`'public'\`; \`'ui'\` keeps HTTP / Web \`callAction\` (and \`GET /api/actions\` manifest for UI validation) and \`ctx.host.invokeAction\` while hiding from CLI / \`<available_actions>\` and rejecting \`run_action\` (execute & describe), Workflow DSL, and \`exposeAsTool\`; \`'internal'\` is restricted strictly to plugin-to-plugin \`ctx.host.invokeAction\` (omitted from \`GET /api/actions\`; rejects HTTP, \`run_action\`, Workflow DSL, \`exposeAsTool\`, and \`composer.completer\`), with the kernel stamping an unforgeable \`context.callerPluginId\` on \`PluginActionContext\` (caller-supplied values on \`context\` are ignored). \`exposeAsTool: true | { name?, description?, replay?, formatOutput? }\` derives a standalone model tool from the same single-point \`ctx.action\` declaration (not duplicated in \`<available_actions>\`; \`name\` sets an explicit provider-safe tool name instead of the hashed alias, \`description\` overrides model-facing copy, \`replay: 'safe' | 'unsafe'\` forwards cross-restart replay safety, \`formatOutput(input, output)\` formats model text while \`handler\` still returns the raw \`outputSchema\`-validated value, and \`context.callId\` carries the SDK tool call ID on the derived-tool path); \`ctx.tool\` is reserved for model-only tools outside the five-end mapping; both support \`promptSnippet\` (a full paragraph) / \`promptGuidelines\` (a bullet list): guidance injects only when actually activated, without duplicating the catalog; on disable or unreachable scope, the catalog, tools, and prompt fragments are cleaned automatically, leaving no phantoms. \`idempotent: true\` marks read-only/idempotent actions, allowing workflows to rerun them across broken chains after failure or interruption.
- Tool three-channel separation (\`output\` / \`structuredOutput\` / \`presentationMeta\`): \`ctx.tool({ name, description, inputSchema, structuredOutputSchema?, presentationMetaSchema?, scope?, promptSnippet?, promptGuidelines?, execute })\` separates model text from programmatic data and UI replay metadata. Returning a plain string goes to \`output\`; otherwise return an explicit \`PluginToolResultEnvelope\` (\`{ output?, structuredOutput?, presentationMeta?, isError? }\`): \`output\` (\`string\` or \`Array<{ type: 'text', text: string }>\`) is delivered to the model (32 KiB spill boundary); \`structuredOutput\` is machine-readable data for programmatic/nested callers (requires declaring \`structuredOutputSchema\`; SecretStash-redacted and schema-validated synchronously; never auto-mirrored to persisted \`details\` or model prompts); \`presentationMeta\` is a bounded plain JSON object persisted to \`pi.tool-result.model[0].details\` for UI/timeline replay (\`ToolViewProps.presentationMeta\` and \`TimelineToolCallSummary.presentationMeta\`; never enters model prompts or context usage) and requires declaring \`presentationMetaSchema\` (validated synchronously against \`presentationMetaSchema\` + SecretStash redaction + hard limits: 64 KiB UTF-8, depth 12, 2000 nodes; rejects prototype keys, non-enumerable/Symbol own keys, circular refs, sparse arrays, \`undefined\`, non-finite numbers, functions/BigInt; bare \`details\` in envelopes is explicitly rejected). For \`ctx.action\` with \`exposeAsTool\` enabled (\`true\` or \`{ name?, description?, replay?, formatOutput? }\`), \`handler\` keeps returning the naked business value validated against \`outputSchema\` (propagated as \`structuredOutputSchema\` on the derived tool, preserving five-end parity); optionally declare \`formatOutput(input, output)\` for concise redacted model text and \`presentationMetaSchema\` + pure \`projectPresentationMeta(input, output)\` to project bounded UI \`presentationMeta\` (registration rejects \`presentationMetaSchema\`/\`projectPresentationMeta\` when \`exposeAsTool\` is not enabled, or \`projectPresentationMeta\` without \`presentationMetaSchema\`).
- \`ctx.host.execEnv(req, opts?)\` executes commands across nodes via the kernel EnvFabric (reusing local / remote @helmx/node channels and redaction), tracked as in-flight tasks (withTask).
- \`ctx.host.forkConversation(id, { entryId?, title? })\` hot-forks a new conversation from a specified visible entry or, when \`entryId\` is omitted, from the latest clean anchor of the source conversation (automatically skipping trailing unclosed \`toolCall\`s; same source as \`POST /api/conversations/:id/fork\`, tracked as in-flight; a missing source conversation or entry throws 404, an invalid \`entryId\` 400, and empty completed non-system history 409 \`fork_empty_history\`). To derive a native sub-conversation from the parent conversation's currently completed history through the \`agent_spawn\` pipeline, pass \`ctx.host.spawnAgent({ ..., fork: true })\` (automatically avoiding unclosed toolCalls).
- \`ctx.host.openTunnel(nodeId, target, signal?)\` opens TCP (\`{ host?, port }\`) duplex streams to the target node via EnvFabric (the node resolves host, defaulting to \`127.0.0.1\`; active tunnels are tracked as in-flight). No companion plugin code is needed on the node side. \`ctx.host.nodeIpc.listNodes()\` returns a read-only snapshot (\`NodeInfo[]\`) of registered compute nodes without credentials or tokens (also permitted during \`stopWindow\`).
- \`ctx.doc(name, initial, { public: true, durable? })\` exposes global state (enters the global SSE first frame; updates broadcast in full; pass \`durable: false\` for in-memory transient state that skips SQLite and clears on disable/restart); frontend components subscribe via \`usePluginDoc(name)\`. Secret fields of \`ctx.configSchema\` go into credential storage, keeping them out of the public doc and \`PluginSummary.publicConfig\`; \`ctx.getConfig()\` merges schema defaults with persisted overrides and is guarded across \`defining\`, active, and \`stopWindow\` (throwing \`409 plugin_context_closed\` after disable/epoch advance). String fields may declare \`format: 'model' | 'node' | 'profile'\` to get a host-rendered standard picker (model catalog / compute node / Profile; stored values stay plain string ids; rendering rights always stay with the host -- plugins never ship their own form controls).
- \`ctx.sessionDoc(name, initial, { public: true, durable? })\` exposes state sharded per conversation (\`durable: true\` persists to SQLite; \`durable: false\` keeps transient state strictly in process memory and auto-clears on disable, conversation deletion, or restart): handles \`get/set/update/delete(conversationId, ...)\` (e.g. \`metrics.update(input.conversationId, cur => ({ count: cur.count + 1 }))\`); frontend components subscribe per current conversation with \`usePluginSessionDoc("metrics")\` or \`usePluginSessionDocState("metrics")\`; never enters the global first frame or global broadcast -- when public, a dedicated SSE (\`GET /api/plugins/:id/docs/:name/events?conversationId=N\`) pushes only to clients subscribed to that conversation; conversation deletion cascades cleanup, and writes after deletion are rejected. Session-scoped UI state (per-conversation task lists, run details) always uses sessionDoc instead of doc to avoid global write amplification; doc and sessionDoc must not share a name.
- \`ctx.kv<T>(namespace)\` provides lightweight per-plugin keyed KV storage backed by \`state.sqlite\` (\`helmx_plugin_kv\`) with \`get(key)\`, \`set(key, value)\`, \`delete(key)\`, \`list({ prefix?, limit?, cursor? })\`, \`clear()\`, and \`flush()\` (avoiding whole-namespace JSON serialization); \`namespace\` (\`^[A-Za-z0-9._-]{1,64}$\`) and \`key\` (1..256 printable chars) are validated at the boundary, values are SecretStash-redacted before persisting and bounded to 256 KiB UTF-8 per entry (\`413 plugin_kv_too_large\`), handles are epoch-guarded (with controlled \`stopWindow\` flush during \`stop()\`), retained across disable/enable, and purged on plugin uninstall.
- \`ctx.provide<T>(capabilityId, impl)\`, \`ctx.consume<T>(capabilityId)\`, and \`ctx.onCapabilityChanged(capabilityId, listener)\` form the typed inter-plugin (and kernel) capability registry: \`capabilityId\` is strictly validated (\`^[a-z0-9][a-z0-9._-]{0,63}$\`), \`provide\` returns an idempotent release function and auto-releases on disable/stop/rollback/uninstall, \`consume\` returns only active plugins' implementations (\`ReadonlyArray<{ pluginId: string; impl: T }>\`), and \`ctx.onCapabilityChanged(capabilityId, listener)\` notifies whenever active providers for \`capabilityId\` change (returning an idempotent unsubscribe callback and auto-releasing on disable/stop/rollback). Well-known contracts include \`helmx.dispatch-tools\` (collaboration dispatch tool names) and \`helmx.model-tiers\` (live model-tier resolution consumed by kernel \`ModelRegistry\`).
- \`ctx.route({ method, path, public?, handler })\` mounts raw Web Standard HTTP routes under \`/api/plugins/<encodeURIComponent(pluginId)>/routes<path>\`: supports \`GET | POST | PUT | PATCH | DELETE | HEAD\`, extracts percent-decoded \`:param\` segments into the 2nd argument \`{ params }\` (\`handler(req, { params })\`; static routes take precedence over parameterized ones, and duplicate/structurally colliding routes are rejected at registration with \`400 validation_error\`), tracks open streaming response bodies in \`liveTasks\` until EOF/cancel/abort, and automatically redacts \`text/*\` (incl. streaming \`text/event-stream\`), \`application/x-ndjson\`, and \`application/json\` / \`*+json\` (JSON-aware up to 4 MiB, streaming fallback above 4 MiB) responses through \`SecretStash\` while passing binary streams untouched without buffering. Frontend views call plugin routes with \`usePluginContext().fetchRoute(path, init?)\`. Tool names and public CLI action paths are also enforced unique at registration/enable commit (rejecting collisions against \`KERNEL_TOOL_NAMES\`, \`CORE_CLI_COMMAND_PATHS\`, or active plugins with \`409 duplicate_tool_name\` / \`409 duplicate_cli_command\`).
- \`ctx.service({ id, start, stop })\` manages background services; declaring liveTasks lets in-flight tasks be reported before disabling. Inside service.start you can bootstrap managed skills via \`ctx.host.skills.ensureSkill({ id, skillMd, references })\` (the standard home for long manuals -- do not stuff them into promptGuidelines):

\`\`\`ts
const SKILL_MD = \`---
name: deploy-guide
description: Deployment playbook (the model decides when to load by this sentence)
managedByPlugin: my-plugin
---

# Deployment
Read references/rollback.md first for rollback scenarios.
\`

ctx.service({
  id: 'skill-bootstrap',
  async start() {
    await ctx.host.skills.ensureSkill({
      id: 'deploy-guide',
      skillMd: SKILL_MD,
      references: { 'rollback.md': '# Rollback\\n...' },
    })
  },
  async stop() {},
})
\`\`\`

  \`managedByPlugin\` must be this plugin's ID (the host validates the binding); the skill automatically leaves the available catalog when the plugin disables and returns on enable, while still being filtered by Profile.skills whitelists (catalog-limited Profiles must opt in explicitly) -- kernel-owned core skills (managedByPlugin: core:*) such as helmx-cli are always enabled at the host level while still respecting Profile.skills whitelists.

Key points:
- External plugin ids forbid the \`builtin:\` prefix, forbid name collisions with registered plugins, and cannot self-declare locked; after placing into the directory, \`helmx plugins rescan\` discovers them incrementally (or a Hub restart auto-discovers), registered disabled by default.
- Managed installs: \`helmx plugins install <source>\` supports four sources -- \`npm:<spec>\`, \`git:<repo>@<ref>\`, HTTPS Git URLs, and local paths (resolved and fetched by the Hub server; a local path means a path on the Hub host; reinstalling the same canonical local directory hot-updates idempotently while preserving \`ctx.doc\` data and ensuring enabled unless \`enable: false\`); \`helmx plugins update <id>\` updates, \`helmx plugins remove <id> [--yes]\` removes (a destructive operation requiring confirmation; use --yes non-interactively); install records (PluginPackageRecord) are persisted by the installer, and PluginSummary carries optional managed metadata. Installing and enabling executes trusted plugin code inside the Hub process, with no sandbox -- install only trusted sources. The hand-managed directory route (init + rescan) remains available.
- Enable: \`helmx plugins enable my-plugin\`; after editing entry code use \`helmx plugins reload my-plugin\` for a controlled hot reload (static self-check precheck first; on failure the old instance stays untouched; no Hub restart needed). Disable/enable only rebuilds the lifecycle of existing definitions. Disabling or uninstalling with in-flight tasks is explicitly refused (409 plugin_has_live_tasks).
- Do not restart the Hub inside your own turn; finish delivering results first, then schedule the process restart.
- Frontend React components (client.tsx) compile dynamically via esbuild and may import react / react-dom / lucide-react / @helmx/plugin-client (host-shared instances; never bundle a second React). @helmx/plugin-client additionally shares the accessible foundation components: Switch, Select, MultiSelect (internal search uses \`SearchBox(size="sm", surface="subtle")\`), Checkbox, Tabs/TabsList/TabsTrigger/TabsContent/TabCount (also \`Tabs.Count\`, inline \`tabular-nums\` count; \`TabsVariant\` is \`'underline' | 'segmented' | 'pills'\` with \`'default'\` removed; \`underline\` is strictly for container/drawer divider tab bars with \`TabsList scrollable\` overflow fade masks; \`segmented\` for 2–5 modes; \`pills\` for multi-filter bars), SegmentedControl, HelmxIcon, ViewBoundary, Callout, Dialog/DialogPortal/DialogOverlay/DialogContent/DialogTitle/DialogDescription/DialogClose/DialogTrigger, ModalDialog (canonical centered modal shell symmetric to \`DetailDrawer\`: \`open\`, \`onClose\`, \`title\`, \`icon?\`, \`titleExtra?\`, \`description?\`, \`size?: 'sm' | 'md' | 'lg' | 'fullscreen'\`, \`flushBody?\`, \`headerActions?\`, \`footer?\`, \`closeDisabled?\`, \`closeLabel?\`, \`inline?\`, \`onOpenAutoFocus?\`, \`onEscapeKeyDown?\` — use instead of raw \`.modal-backdrop\`/\`.modal-header\`/\`.modal-footer\`), Kbd (unified keyboard shortcut badge \`size?: 'sm' | 'md'\`, \`desktopOnly?\` rendering \`<kbd className="helmx-kbd ...">\` — use instead of raw \`.kbd-hint\`), Popover/PopoverTrigger/PopoverContent/PopoverClose, Tooltip/TooltipProvider/TooltipRoot/TooltipTrigger/TooltipContent, DropdownMenu/DropdownMenuRoot/DropdownMenuTrigger/DropdownMenuPortal/DropdownMenuContent/DropdownMenuItem/DropdownMenuSeparator/DropdownMenuLabel/DropdownMenuGroup (unified canonical overlay surface shared with \`Popover\`/\`Select\`/\`ModelPicker\`; \`DropdownMenuItem\` supports optional structured slots \`icon?: string | ReactNode\`, \`description?\`, \`shortcut?\`, \`trailing?\`, \`checked?\`, \`danger?\`), AlertDialog/AlertDialogPortal/AlertDialogOverlay/AlertDialogContent/AlertDialogTitle/AlertDialogDescription/AlertDialogAction/AlertDialogCancel/AlertDialogTrigger (confirm dialogs) plus the high-level ConfirmDialog (double-confirm composition with danger variant and pending state), SearchBox (unified container-class search input with \`variant?: 'default' | 'toolbar'\`, \`surface?: 'default' | 'subtle' | 'frameless'\`, \`size?: 'sm' | 'md'\`, single clear button, Esc clear/blur in toolbars; always type="text" — never hand-roll search inputs in sidebars, popovers, or modals), EmptyState (host .empty-state vocabulary with optional icon/title/hint/compact/prominent/action), LoadingState (unified \`.loading-state\` + \`.spin-slow\` loading indicator), MarkdownView, MarkdownText, CodeBlockView, CopyButton, ToolCallDetails (read-only tool-call detail body: raw input/output code blocks plus artifact open button via ctx.openArtifact, reusing the host trace vocabulary), PluginSlot, PluginScope (layout-transparent \`display: contents\` anchor stamping \`data-plugin-id\` for custom plugin subtrees/portals), StatusLight (unified status light: visually dot-only for card main status slots; accepts either explicit \`tone: StatusLightTone\` + required \`label\`/\`aria-label\` or raw \`status: string\`; exports \`STATUS_LIGHT_TONES\`, \`normalizeStatusLightTone\`, and \`isKnownStatusLightStatus\` from the root \`@helmx/plugin-client\` entry — never import \`@helmx/plugin-client/pure\` from plugins), core form and display primitives Button / IconButton (5 orthogonal variants: \`secondary\` [Button default] | \`primary\` | \`ghost\` [IconButton default] | \`danger\` | \`inline\` — never \`default\`; sizes \`md\` 32px / \`sm\` 28px / \`xs\` 22px; \`pending\` busy state; \`forwardRef\` compatible with Radix \`asChild\`), Badge (\`neutral | accent | ok | warn | err\`, \`icon\`, \`mono\`, sharp \`5px\` radius), Stack (flex direction/gap mapped to \`--space-1..5\` without inline styles), Input / Textarea (\`size: 'sm' | 'md'\`, native \`prefix\` / \`suffix\` / \`inputClassName\` on Input, \`mono\`/\`invalid\` + automatic FieldContext wiring), Field / HelperText / ErrorText (non-wrapping \`<label htmlFor>\` or \`htmlFor={false}\` \`role="group"\` + FieldContext propagation to Input/Textarea/Select/MultiSelect/Switch/Checkbox/ModelPickerControl), Card (static container with \`elevated | subtle\` and \`default | warn | danger\`), SelectCard + CardGrid (stage-grid selectable object card with 32x32 \`icon\`, inline \`badges\`, 2-line clamped \`description\`, body \`children\` for sharp \`5px\` \`<Badge>\` tags, sibling trigger + \`actions\` / single-line \`size="xs"\` \`footer\` slots, and narrow-pane-safe \`minmax(min(100%, ...), 1fr)\` grid), List + ListRow (Hairline Roster List primitives: \`density: 'default' | 'compact'\`, sibling-slot a11y with \`<button aria-pressed>\` trigger + \`leading\`/\`title\`/\`meta\`/\`description\`/\`trailing\`/\`actions\` slots + \`@container (max-width: 680px)\` responsive collapse), MonoId (truncating monospace identifier pill + integrated CopyButton), plus the unified page layout primitives Screen (single page shell with \`layout?: 'contained' | 'full-bleed'\`, sticky full-bleed \`toolbar\`, \`actions\`, \`topbar\`/\`icon\`/\`topbarEnd\`/\`banner\`/\`overlays\`), ScreenSection (sectioning), DataTable (composable table shell with unified \`<LoadingState>\` and \`<EmptyState compact>\` rows; thead/rows expressed as children JSX; narrow panels \`< 560px\` capped at 3 columns), KvGrid (items: Array<{key,value}> key-value overview), ScreenToolbar (single-layer toolbar row: left switch/filters + right \`actions\` such as \`SearchBox(variant="toolbar", size="sm")\`, wrapping both in \`ScreenToolbarContext\`), DetailDrawer (right-side detail drawer shell over the shared .primary-drawer-* CSS vocabulary: open/onClose controlled, title + titleExtra badges + optional icon/meta lines, composable body and footer; empty/loading states stay caller JSX), DockTray / DockTrayRow (shared composer-dock in-flight activity HUD tray and expandable row primitives over the shared .dock-tray* CSS vocabulary; composer status pills use the shared \`22px\` \`.helmx-toolbar-pill\` family), and the generic formatting pure functions formatTime (MM-DD HH:mm), formatCompactTimestamp (MM-DD HH:mm:ss), formatDurationMs (millisecond duration summary), formatStopwatchMs (1Hz whole-second stopwatch Xs / XmYYs / XhYYm), formatOffsetMs (relative offset +MM:SS / +H:MM:SS), resolveConversationTiming (honest conversation timing snapshot over status/runDurationMs/runStartedAt/pendingAskSince/nowMs), formatBytes (human-readable bytes, base 1024) -- prefer reusing these primitives and formatters for common structures instead of building native controls, raw/legacy \`.btn*\`/\`.input*\`/\`.section-flat\`/\`.form-grid\`/\`.kv-list\`/\`.card\`/\`.tabs-bar\`/\`.tab-btn\`/\`.modal-header\`/\`.modal-footer\`/\`.dropdown-panel\`/\`.kbd-hint\` HTML tags, duplicate formatters, or new CSS themes. ModelPickerControl is the shared model + thinking-level picker (supporting \`variant?: 'composer' | 'field'\`, \`size?: 'sm' | 'md'\`, \`invalid?\`, \`className?\` — use \`variant="field"\` in forms/drawers for a 32px/28px bordered trigger matching Select with FieldContext wiring and \`popoverSide="bottom"\`; reads the catalog via the useHostModels host port slice; row body click applies the model with a null level so thinking follows the server-authoritative default chain, level chips commit model + level together, \`showThinkingLevels={false}\` renders plain model-id picking for config fields, display copy arrives via the \`copy\` prop with English SDK defaults) with the model display helpers formatModelShortName and resolveEffectiveThinkingLevel (thinking-level convergence against a model's supported list), resolveDefaultChainThinkingLevel (kernel-ordered \`conversation\` / \`compaction\` default-chain resolution), and usePanelShortcut (panel-scoped listener for host \`helmx:shortcut\` events such as \`toggle-model-picker\` / \`toggle-plan-mode\`, matched against the element's enclosing \`[data-helmx-panel]\`) -- prefer reusing these primitives and formatters for common structures instead of building native controls, duplicate formatters, or new CSS themes.
- Shared hooks: usePluginLocale() resolves the active \`en\` / \`zh-CN\` UI locale; usePluginTranslator() returns a stable translator for localized display copy; usePluginAction() wraps \`ctx.callAction\` with synchronous re-entrancy mutex, \`pending\`/\`pendingKey\`/\`error\`/\`clearError\`, optional \`notifyError\`, and unmount guard; useToolActivity(callId, active) reports background tool activity of the owning timeline turn; useTimelineToolCalls(toolName) subscribes reactively to lightweight chronological TimelineToolCallSummary snapshots ({ callId, toolName, index, status, input?, presentationMeta? }, omitting bulky result/resultTruncation/structuredOutput) sharded by toolName within the enclosing timeline (TimelineToolCallsContext) -- unrelated toolName updates never trigger re-renders, unchanged shards keep referential stability, and outside a timeline Provider (or with an empty toolName / SSR) it returns a shared frozen empty array; useComposerCommand(commandId, handler) registers a composer-local handler for a plugin's \`CommandSpec\` inside Composer / AgentStandbyPane slots so slash picks and exact submissions execute interactively without raw RPCs or one-off protocol fields; useComposerModelPickerMode(key, spec) registers a panel-local selectable mode tab inside the host Composer / AgentStandbyPane \`ModelPickerControl\` (keeping \`onApply\` in a ref without re-render churn, and returning \`{ openMode }\` to jump directly to that mode tab); usePluginDocState<T>(name, pluginId?) reactively subscribes to a public global doc with honest three-state \`{ data, status: 'loading' | 'ready' | 'error', error?, retry }\` (cross-plugin addressing supported) and usePluginDoc<T>(name, pluginId?) is its thin value wrapper; usePluginSessionDocState<T>(name, conversationIdOrOptions?) subscribes to a public session doc per conversation (accepts a numeric \`conversationId\` or \`{ conversationId?, pluginId? }\`, returning \`{ data, status, error?, retry }\`; multi-component shared subscription; unsubscribes at zero references; first-frame restore on reconnect; \`retry()\` reconnects after errors) and usePluginSessionDoc<T>(name, {conversationId?, pluginId?}?) is its thin value wrapper; useConversations() for all conversation summaries; useConversation(id) for a single conversation's live view (summary/detail/live/pendingAsks); usePlugins() for a reactive snapshot of the host plugin list and Screen contributions (plugins + screens, live-synced via SSE -- app-center-style views use it to sense installed apps and their main views' enablement); usePluginConfig<T>() for the current plugin's reactive non-secret configuration (\`PluginSummary.publicConfig\`, excluding all \`secret: true\` fields; returns \`{}\` when unset; usable inside \`<PluginUiView>\`); useHostModels() for the host's normalized read-only model catalog slice (stable host-port subscription isolated from host streaming churn: \`HostModelEntry\` list with per-model thinking levels plus the global default chain -- \`undefined\` means the capability is not injected or the catalog has not finished its first load, render unknown/loading and disable selection; a slice with \`models: []\` means loaded and genuinely empty, the two are strictly distinct; dynamic refresh is only the optional \`refreshModels\` port action, absent means the host offers no refresh -- hide the entry, surface \`errors\` verbatim when present); useHostNodes() for the host's read-only compute node list slice (\`HostNodesSlice | undefined\`, never exposing node tokens) and useHostProfiles() for the host's read-only Profile catalog slice (\`HostProfilesSlice | undefined\`, excluding \`SYSTEM.md\` bodies), both using the same isolated host-port subscription and honest \`undefined\` (not injected / initial load incomplete) vs \`[]\` (loaded and empty) semantics; useScreenParams() for the screen-local params scope provided by the host ScreenHost (returns null outside a plugin screen -- honest absence, never a fake no-op scope; params/setParams bind the owning pane's URL-hash-backed scope so the hash stays the single source of truth, and isSplit reports the split-pane context); useScreenDrawer(options?) for URL-hash-synced \`DetailDrawer\` state (\`{ open, mode, itemId, creating, openItem, openCreate, close, drawerProps }\`, automatically pushing history when opening from closed and replacing on item switch / close, with local state fallback when outside a screen); useSharedNowMs() for the shared coarse-grained current timestamp (ticks cleanly for relative durations without per-component timers); <PluginSlot name> declares child slots; usePluginContext() provides callAction(actionId, input, {pluginId?, conversationId?}) (cross-plugin capable), fetchRoute(path, init?) (authenticated fetch scoped to \`/api/plugins/<encodeURIComponent(pluginId)>/routes<path>\` where the host injects the Bearer token without exposing it to plugin code; \`path\` must start with \`/\` and stay inside this plugin's route namespace, returning raw \`Response\` untouched for JSON, binary, \`FormData\`, or SSE streams), submitInput(text, {conversationId?, whenBusy?}), openScreen/openSplitScreen/openConversationDrawer/openArtifact/openWorkbench(panelId?, params?) (auto-qualifies local \`panelId\` to \`plugin:<pluginId>/<panelId>\` while keeping \`'artifacts'\`/\`'files'\`/\`'plugin:...'\`, and passes transient \`params\` to \`WorkbenchPanelProps.params\`), notify, and more.
- Plugin view styles live in a local .css inside clientRoot (imported; esbuild merges it into the preserved export __helmxClientCss, with the host managing injection, zero-specificity \`:where([data-plugin-id="<pluginId>"])\` scoping synchronized across \`<PluginScope>\` and SDK portals, and reclamation); never write the host's styles.css.
- UI copy strictly forbids Emoji; icons use lucide icon names.
- For the complete extension points and the client.tsx single-track mechanism, see the in-repo docs/architecture/extension-points.md and docs/plugins/plugin-development.md.
- Before writing or modifying any plugin UI (\`client/*.tsx\`), read \`references/ui-hig.md\` first; it defines the single Helmx UI HIG (Quiet Surface principles, 32/28/22px control scale, 5-variant Button, selector and stage archetypes, unified \`<Screen toolbar>\` shell, container density rules, and canonical JSX patterns).
- When client.tsx involves heavy dependencies, dynamic imports, first-screen performance, or async chunks, read \`references/plugin-client-code-splitting.md\` first; that manual specifies the source shape the AI should write, the host bridging internals that must never be touched, verification commands, and failure handling.
`

const PLUGIN_CLIENT_CODE_SPLITTING_TEMPLATE = `# Plugin client.tsx Performance and Code Splitting

This manual targets AIs developing Helmx plugins. Default principle: **the AI writes only standard TypeScript/React and standard ESM \`import()\`; the host handles compilation, chunking, auth, caching, preloading, and invalidation.**

## First decide whether you need this manual

Read this manual before touching plugin code when any of the following applies:

- client.tsx pulls in Mermaid, editors, charts, parsers, maps, or other heavy dependencies;
- users report slow first open, large network downloads, or slow main-thread parsing for a plugin;
- you need \`import()\`, async chunks, or bundle splitting;
- you need to check a plugin client artifact's size, gzip size, or chunk caching;
- you need to troubleshoot chunk load failures after plugin disable/reload/refresh.

Ordinary small plugins need no extra abstraction just for splitting.

## How the AI should write plugin code

### Separate first screen from infrequent features

First-screen-critical, tiny code uses static imports:

\`\`\`tsx
import { useState } from 'react'
import { usePluginContext } from '@helmx/plugin-client'
import './styles.css'
\`\`\`

Heavy, rarely used, or only-after-user-action features use standard dynamic imports:

\`\`\`tsx
async function openAdvancedView(source: string) {
  const { renderAdvancedView } = await import('./advanced-view.ts')
  return renderAdvancedView(source)
}
\`\`\`

If a third-party library itself supports dynamic import, prefer loading the library dynamically:

\`\`\`tsx
const { default: chart } = await import('chart-library')
\`\`\`

Built-in plugins can declare the dependency via controlled \`npmDependencies\`; external plugins declare each bare package name or subpath specifier in \`plugin.json.clientDependencies\` or \`package.json.helmx.clientDependencies\` (the host maps them to controlled dependencies whose resolution root points at the plugin's own directory, and auto-installs them during managed installation); undeclared bare npm specifiers are explicitly rejected by the compiler.

### Keep the entry module light

The entry module contains only:

- components exported for host extension points;
- first-screen-necessary state and event handling;
- small pure functions;
- low-volume style entries.

Never statically import at the entry module's top level a heavy library needed only on button click, dialog open, or a specific data type.

### Dynamic imports keep standard ESM semantics

Dynamic imports must be plain standard form:

\`\`\`ts
const mod = await import('./feature.ts')
\`\`\`

Do not hand-rewrite them into host bridge calls. The compiler analyzes dynamic imports, generates the main module, shared chunks, and on-demand chunks, and rewrites them into host loading bridges at the artifact stage.

## Internal mechanisms the AI must never touch

Plugin source must not:

- call \`globalThis.__helmx_import_chunk\` directly;
- read or write \`globalThis.__helmx_chunk_share\` directly;
- hand-write \`/api/plugins/<id>/client.mjs\` chunk URLs;
- read, splice, or forge \`contentHash\`;
- put Bearer tokens into URLs;
- depend on relative paths of Blob URLs;
- hand-create or cache chunk filenames;
- execute module code via \`eval\`, \`new Function\`, or string concatenation;
- copy files outside clientRoot into runtime paths to bypass the compiler boundary.

These mechanisms belong to the host implementation. Plugins declare only normal module dependencies.

## Import and shared-dependency rules

Importing host shared hooks, components, and contexts from \`@helmx/plugin-client\` is allowed; using the host-declared shared React, React DOM, and lucide-react specifiers is allowed. Do not copy React inside a plugin or hand-write host shared globals.

Plugin-local relative dependencies must live inside \`clientRoot\`. External plugins must not depend on undeclared bare npm packages; the compiler rejects them explicitly instead of silently searching node_modules.

Plugin styles should import relatively from inside clientRoot:

\`\`\`tsx
import './styles.css'
\`\`\`

Never modify the host's \`packages/web/src/styles.css\` to carry plugin business styles. Never treat local image, font, or CSS resource URLs as plugin static-asset endpoints; use inline \`data:\` or explicit HTTP(S) addresses per existing plugin development rules.

## Runtime behavior

The host automatically:

1. analyzes the entry and dynamic imports with esbuild;
2. generates the main module, shared async chunks, and private async chunks;
3. produces content hashes and gzip for artifacts;
4. serves chunks on demand over Bearer-authenticated HTTP endpoints;
5. merges concurrent requests for the same module and chunk;
6. loads shared chunks in dependency-topological order;
7. cleans chunks after disable, reload, logout, or cache-generation changes;
8. returns explicit staleness errors for old hashes instead of silently treating old modules as new.

Therefore the AI must not implement a second loader or hand-write fallbacks based on network state inside components. Load failures must keep the host's explicit error semantics.

## Failure-handling rules

When a dynamic dependency fails to load:

- do not return an empty component pretending success;
- do not swallow the import error;
- do not disguise source text as a rendered result;
- show a clear error with a retry entry at the component layer;
- keep user-copyable source or input content (if the component handles user input).

Asynchronous render results must have unmount/parameter-change/cache-generation guards; late results must not overwrite new state.

## Development verification

External plugins run the real self-check first:

\`\`\`bash
helmx plugins doctor <plugin-id-or-directory>
\`\`\`

After code changes, use the controlled hot reload:

\`\`\`bash
helmx plugins reload <plugin-id>
\`\`\`

Inspect the entry artifact:

\`\`\`bash
helmx plugins client <plugin-id> --module client.tsx --json
\`\`\`

To inspect an async chunk:

\`\`\`bash
helmx plugins client <plugin-id> --module client.tsx --chunk <chunk-name> --json
\`\`\`

Never judge optimization complete from source line counts or theoretical values. Judge by actual compilation results, gzip bytes, the browser Network panel, and real chart/feature operations.

Related tests:

\`\`\`bash
pnpm typecheck
pnpm --filter @helmx/kernel test test/plugin-client.test.ts
pnpm --filter @helmx/web test test/plugin-client-chunks.test.ts
pnpm --filter @helmx/web test test/plugin-client-css.test.ts test/plugin-client-runtime.test.ts
\`\`\`

Test cases follow project conventions, explicitly setting \`{ timeout: 60_000 }\`. When a command fails, report the failing items and logs honestly; never fake a pass with empty implementations, mock data, or silent degradation.

## Completion criteria

A plugin client.tsx change may only be declared complete when all of the following hold:

- the entry and component exports satisfy the clientRoot / ClientComponentRef contract;
- heavy low-frequency dependencies use standard dynamic imports, never unconditionally loaded on the first screen;
- no direct touching of host chunk bridges, hashes, or Bearer URLs;
- \`helmx plugins doctor\` passes;
- related kernel/web tests pass;
- failure paths still show clear diagnostics;
- if you claim a performance optimization, provide actual gzip sizes of the main bundle and chunks, or browser network verification.
`

const helmxCliSkillVars: Record<string, string> = {
  SKILL_ID: HELMX_CLI_SKILL_ID,
  MANAGED_BY: HELMX_CLI_SKILL_OWNER,
  HOOK_COUNT: String(PLUGIN_HOOK_NAMES.length),
  HOOK_NAMES: PLUGIN_HOOK_NAMES.join('、'),
  UI_METHOD_COUNT: String(PLUGIN_UI_METHOD_NAMES.length),
  RESERVED_SLASH_COMMANDS: RESERVED_SLASH_COMMANDS.join('/'),
}

export const HELMX_CLI_SKILL_MD: string = renderSkillTemplate(
  HELMX_CLI_SKILL_TEMPLATE,
  helmxCliSkillVars,
)

export const HELMX_CLI_SKILL_AND_PLUGIN_DEV_MD: string = renderSkillTemplate(
  SKILL_AND_PLUGIN_DEV_TEMPLATE,
  helmxCliSkillVars,
)

export const HELMX_CLI_PLUGIN_CLIENT_CODE_SPLITTING_MD: string = renderSkillTemplate(
  PLUGIN_CLIENT_CODE_SPLITTING_TEMPLATE,
  helmxCliSkillVars,
)

export { HELMX_CLI_UI_HIG_MD }

export const HELMX_CLI_SKILL_ASSET: BuiltinSkillAsset = {
  id: HELMX_CLI_SKILL_ID,
  skillMd: HELMX_CLI_SKILL_MD,
  references: {
    'skill-and-plugin-dev.md': HELMX_CLI_SKILL_AND_PLUGIN_DEV_MD,
    'ui-hig.md': HELMX_CLI_UI_HIG_MD,
    'plugin-client-code-splitting.md': HELMX_CLI_PLUGIN_CLIENT_CODE_SPLITTING_MD,
  },
}
