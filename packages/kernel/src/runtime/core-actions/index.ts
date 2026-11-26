/**
 * Core kernel actions (`core:*` reserved namespace):
 *
 * Registers structured, schema-validated internal actions directly onto `PluginHost` via
 * `registerCoreAction`, reusing `@helmx/protocol` `REQUEST_SCHEMAS` and real kernel services
 * without duplicating business logic.
 *
 * Security & visibility invariants:
 * - Every `core:*` action sets `exposeToPrompt: false` and declares `cli: { command: [...] }` pointing to
 *   its real static `CORE_CLI_COMMAND_PATHS` command (validated at registration; rendered truthfully in
 *   `run_action({ list: true })` and `helmx actions list`, while never dynamically mounted by `@helmx/cli`),
 *   discoverable on demand via `run_action({ list: true, pluginId: "core:" })`;
 * - `core:*` never appears in `PluginHost.list()` / `GET /api/plugins` / Plugin Center;
 * - Watchdog Ownership Red Line (`AGENTS.md` §3): a `helmx`-owned session cannot mutate a `human`-owned
 *   conversation via `core:conversations.{update,send,withdraw,abort,reset,compact,delete}` (`403 ownership_violation`),
 *   and all 7 automated conversation mutations always execute through the kernel guarded APIs
 *   (`updateConversationGuarded`, `submitInputGuarded`, `withdrawQueuedInputGuarded`,
 *   `abortConversationGuarded`, `resetConversationGuarded`, `compactConversationGuarded`,
 *   `deleteConversationGuarded`) carrying `{ expectedOwnership: 'helmx', expectedStateSeq? }`;
 * - Automated `create` / `fork` ownership invariant: `helmx`-owned sessions always produce `'helmx'`-owned
 *   conversations (rejecting explicit `ownedBy: 'human'` with `403 ownership_violation`), and derived `create`
 *   (under a `helmx` parent) / `fork` (from a `helmx` source) inherit `'helmx'` ownership by default;
 * - Self-Mutation Guard: a session cannot `abort`, `reset`, or `delete` itself (`409 self_mutation_forbidden`);
 * - Honest `origin`: `core:conversations.send` always forces `origin: 'agent'` inside any conversation context;
 * - Host-governance mutations require top-level `human`-owned sessions (`scope: { topLevelOnly: true, ownedBy: 'human' }`);
 * - `core:asks.answer` and `core:skills.{list,read}` are blocked from all conversation contexts (`scope: { conversationIds: [] }`);
 * - `core:plugins.config_get` masks `secret: true` fields identically to `GET /api/plugins/:id/config`,
 *   `core:models.providers` exposes only sanitized summaries, and credential writes / `providers.set` /
 *   `nodes.issue` / `env.exec` are intentionally never exposed as `core:*` actions.
 *
 * Layout: one module per domain under `./core-actions/` (`conversation` / `profile` / `model` / `node` /
 * `plugin` / `ask` / `skill`), shared schema fragments and the strict-JSON registrar in `./shared.ts`;
 * this module is the composition root.
 */
import type { PluginActionSpec } from '@helmx/protocol'
import type { PluginHost } from '../../plugins/plugin-host.js'
import type { CoreActionsRuntimeHost } from '../runtime-types.js'
import { registerAskCoreActions } from './ask.js'
import { registerConversationCoreActions } from './conversation.js'
import { registerModelCoreActions } from './model.js'
import { registerNodeCoreActions } from './node.js'
import { registerPluginCoreActions } from './plugin.js'
import { registerProfileCoreActions } from './profile.js'
import { registerSkillCoreActions } from './skill.js'
import { registerCore, type CoreActionRegistrar } from './shared.js'

/** Register all kernel-owned `core:*` actions onto `pluginHost`. */
export function registerCoreActions(runtime: CoreActionsRuntimeHost, pluginHost: PluginHost): void {
  const hostProxy = {
    registerCoreAction: <TIn, TOut>(ownerId: string, spec: PluginActionSpec<TIn, TOut>): void =>
      registerCore(pluginHost, ownerId, spec),
  } as CoreActionRegistrar
  registerConversationCoreActions(runtime, hostProxy)
  registerProfileCoreActions(runtime, hostProxy)
  registerModelCoreActions(runtime, hostProxy)
  registerNodeCoreActions(runtime, hostProxy)
  registerPluginCoreActions(runtime, hostProxy, pluginHost)
  registerAskCoreActions(runtime, hostProxy)
  registerSkillCoreActions(runtime, hostProxy)
}
