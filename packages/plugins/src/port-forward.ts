/**
 * `builtin:port-forward`: persistent Hub-side TCP port forwarding to local and
 * remote compute nodes via EnvFabric `openTunnel`, with management UI, node
 * detail slot, and settings panel.
 */
import { randomUUID } from 'node:crypto'
import {
  HelmxError,
  NODE_DETAIL_SECTION_SLOT,
  type PluginDefinition,
} from '@helmx/protocol'
import { resolvePluginClientAssets } from './asset-paths.js'
import {
  DELETE_OUTPUT_SCHEMA,
  LIST_OUTPUT_SCHEMA,
  MAX_PORT_FORWARD_RULES,
  MUTATION_OUTPUT_SCHEMA,
  PAUSE_RUNTIME_OUTPUT_SCHEMA,
  PORT_FORWARD_PLUGIN_ID,
  PORT_FORWARD_RULES_DOC,
  PORT_FORWARD_RUNTIME_DOC,
  PORT_FORWARD_SCREEN_ID,
  RESERVED_HUB_PORTS,
  STOP_ALL_OUTPUT_SCHEMA,
  type PortForwardListenerState,
  type PortForwardPluginConfig,
  type PortForwardRule,
  type PortForwardRulesDoc,
  type PortForwardRuntimeDoc,
  type PortForwardRuntimeEntry,
  type PortForwardViewItem,
} from './port-forward/contracts.js'
import { PortForwardManager } from './port-forward/forward-manager.js'
import {
  assertListenHostAllowed,
  assertNoListenConflict,
  defaultRuleName,
  normalizeHost,
  normalizeNodeId,
  normalizePort,
  normalizeRuleName,
  sanitizeRulesDoc,
} from './port-forward/validation.js'

export {
  MAX_PORT_FORWARD_RULES,
  PORT_FORWARD_PLUGIN_ID,
  PORT_FORWARD_RULES_DOC,
  PORT_FORWARD_RUNTIME_DOC,
  PORT_FORWARD_SCREEN_ID,
  RESERVED_HUB_PORTS,
  type PortForwardListenerState,
  type PortForwardPluginConfig,
  type PortForwardRule,
  type PortForwardRulesDoc,
  type PortForwardRuntimeDoc,
  type PortForwardRuntimeEntry,
  type PortForwardViewItem,
}

export function createPortForwardPlugin(): PluginDefinition {
  return {
    id: PORT_FORWARD_PLUGIN_ID,
    name: { en: 'Port Forwarding', 'zh-CN': '端口映射' },
    description: {
      en: 'Persistent Hub-side TCP port forwarding to local and remote nodes via EnvFabric tunnels, with a full management screen.',
      'zh-CN': '基于 EnvFabric 隧道的持久化 TCP 端口映射与管理界面，支持将本地或远端节点服务安全映射至 Hub 本机端口。',
    },
    icon: 'network',
    version: '0.1.0',
    ...resolvePluginClientAssets(
      PORT_FORWARD_PLUGIN_ID,
      'port-forward',
      'port_forward_plugin_client_missing',
    ),
    definePlugin(ctx) {
      ctx.configSchema({
        allowPublicBind: {
          type: 'boolean',
          default: false,
          label: {
            en: 'Allow non-loopback bind addresses',
            'zh-CN': '允许绑定非回环地址',
          },
          description: {
            en: 'Allow port-forward rules to listen on non-loopback addresses such as 0.0.0.0 or ::. Disabled by default to prevent exposing node services to external networks.',
            'zh-CN': '允许端口映射规则监听 0.0.0.0 或 :: 等非回环地址。默认关闭，以防将节点内网服务暴露到外部网络。',
          },
        },
      })

      const rulesDoc = ctx.doc<PortForwardRulesDoc>(
        PORT_FORWARD_RULES_DOC,
        { items: [] },
        { public: true },
      )
      const runtimeDoc = ctx.doc<PortForwardRuntimeDoc>(
        PORT_FORWARD_RUNTIME_DOC,
        { byId: {} },
        { public: true, durable: false },
      )

      let writeChain: Promise<unknown> = Promise.resolve()
      let cachedRules: PortForwardRule[] | undefined

      const enqueueWrite = <T>(op: () => Promise<T>): Promise<T> => {
        const run = writeChain.then(op, op)
        writeChain = run.then(
          () => undefined,
          () => undefined,
        )
        return run
      }

      const readRules = (): PortForwardRule[] => {
        if (cachedRules === undefined) {
          cachedRules = sanitizeRulesDoc(rulesDoc.get()).items
        }
        return cachedRules
      }

      const persistRules = async (items: PortForwardRule[]): Promise<void> => {
        const sanitized = sanitizeRulesDoc({ items })
        rulesDoc.set(sanitized)
        cachedRules = sanitized.items
        try {
          await rulesDoc.flush()
        } catch (err) {
          cachedRules = undefined
          throw err
        }
      }

      const getAllowPublicBind = (): boolean =>
        (ctx.getConfig() as PortForwardPluginConfig).allowPublicBind === true

      const manager = new PortForwardManager({
        host: ctx.host,
        runtimeDoc,
        getRules: readRules,
        getAllowPublicBind,
      })

      const isNodeOnlineSafe = (nodeId: string): boolean | undefined => {
        try {
          return ctx.host.nodeIpc.isOnline(nodeId)
        } catch (err) {
          if (err instanceof HelmxError && err.code === 'node_ipc_unavailable') {
            return undefined
          }
          throw err
        }
      }

      const toViewItem = (rule: PortForwardRule): PortForwardViewItem => {
        const runtime = manager.getRuntimeEntry(rule.id)
        const nodeOnline = isNodeOnlineSafe(rule.nodeId)
        return {
          ...rule,
          ...runtime,
          ...(nodeOnline !== undefined ? { nodeOnline } : {}),
        }
      }

      ctx.service({
        id: 'port-forward-runtime',
        prepare() {
          manager.resetForStart()
          cachedRules = sanitizeRulesDoc(rulesDoc.get()).items
        },
        start() {},
        async reconcile() {
          await manager.reconcile()
        },
        async stop() {
          await manager.stop()
          await writeChain
          cachedRules = undefined
        },
        inUse() {
          return manager.inUseItems()
        },
      })

      ctx.action<Record<string, never>, { items: PortForwardViewItem[]; allowPublicBind: boolean }>({
        id: 'list',
        description: 'List all configured port-forward rules merged with live Hub listener runtime state',
        exposeToPrompt: false,
        idempotent: true,
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        outputSchema: LIST_OUTPUT_SCHEMA,
        handler() {
          return {
            items: readRules().map(toViewItem),
            allowPublicBind: getAllowPublicBind(),
          }
        },
      })

      ctx.action<
        {
          name?: string
          nodeId: string
          listenHost?: string
          listenPort: number
          targetHost?: string
          targetPort: number
          enabled?: boolean
        },
        { item: PortForwardViewItem }
      >({
        id: 'create',
        description: 'Create a persistent Hub-to-node TCP port-forward rule and optionally start listening immediately',
        exposeToPrompt: false,
        inputSchema: {
          type: 'object',
          required: ['nodeId', 'listenPort', 'targetPort'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', description: 'Optional human-readable label for the rule' },
            nodeId: { type: 'string', minLength: 1, description: 'Target compute node ID (e.g. local or remote nodeId)' },
            listenHost: { type: 'string', description: 'Hub listen IP/host address (defaults to 127.0.0.1)' },
            listenPort: {
              type: 'integer',
              minimum: 1,
              maximum: 65535,
              description: 'Hub TCP listen port (1-65535, excluding reserved Hub ports)',
            },
            targetHost: {
              type: 'string',
              description: 'Target host resolved from the destination node perspective (defaults to 127.0.0.1)',
            },
            targetPort: {
              type: 'integer',
              minimum: 1,
              maximum: 65535,
              description: 'Target TCP port on the destination node (1-65535)',
            },
            enabled: {
              type: 'boolean',
              description: 'Whether to start listening immediately and auto-start on Hub boot (defaults to true)',
            },
          },
        },
        outputSchema: MUTATION_OUTPUT_SCHEMA,
        handler: (input) =>
          enqueueWrite(async () => {
            const nodeId = normalizeNodeId(input.nodeId)
            const listenHost = normalizeHost(input.listenHost, 'listenHost', '127.0.0.1')
            const listenPort = normalizePort(input.listenPort, 'listenPort')
            const targetHost = normalizeHost(input.targetHost, 'targetHost', '127.0.0.1')
            const targetPort = normalizePort(input.targetPort, 'targetPort')
            const enabled = input.enabled !== false
            const name = normalizeRuleName(
              input.name,
              defaultRuleName(nodeId, listenPort, targetHost, targetPort),
            )

            assertListenHostAllowed(listenHost, getAllowPublicBind())

            const prevItems = readRules()
            if (prevItems.length >= MAX_PORT_FORWARD_RULES) {
              throw new HelmxError(
                'validation_error',
                `At most ${MAX_PORT_FORWARD_RULES} port-forward rules are allowed`,
                400,
                { maxRules: MAX_PORT_FORWARD_RULES },
              )
            }
            assertNoListenConflict({ listenHost, listenPort }, prevItems)

            const now = Date.now()
            const rule: PortForwardRule = {
              id: randomUUID(),
              name,
              nodeId,
              listenHost,
              listenPort,
              targetHost,
              targetPort,
              enabled,
              createdAt: now,
              updatedAt: now,
            }
            await persistRules([...prevItems, rule])

            if (rule.enabled) {
              try {
                await manager.startRule(rule)
              } catch (err) {
                // Honesty rollback: remove unstartable newly-created rule instead of leaving a broken ghost rule.
                await persistRules(prevItems)
                manager.clearEntry(rule.id)
                throw err
              }
            }
            return { item: toViewItem(rule) }
          }),
      })

      ctx.action<
        {
          id: string
          name?: string
          nodeId?: string
          listenHost?: string
          listenPort?: number
          targetHost?: string
          targetPort?: number
          enabled?: boolean
        },
        { item: PortForwardViewItem }
      >({
        id: 'update',
        description: 'Update an existing port-forward rule configuration and reconcile its live Hub listener',
        exposeToPrompt: false,
        inputSchema: {
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: {
            id: { type: 'string', minLength: 1, description: 'Rule ID to update' },
            name: { type: 'string', description: 'Updated rule label' },
            nodeId: { type: 'string', minLength: 1, description: 'Updated target compute node ID' },
            listenHost: { type: 'string', description: 'Updated Hub listen IP/host address' },
            listenPort: {
              type: 'integer',
              minimum: 1,
              maximum: 65535,
              description: 'Updated Hub TCP listen port (1-65535)',
            },
            targetHost: { type: 'string', description: 'Updated target host on destination node' },
            targetPort: {
              type: 'integer',
              minimum: 1,
              maximum: 65535,
              description: 'Updated target TCP port on destination node (1-65535)',
            },
            enabled: { type: 'boolean', description: 'Updated persisted desired enabled state' },
          },
        },
        outputSchema: MUTATION_OUTPUT_SCHEMA,
        handler: (input) =>
          enqueueWrite(async () => {
            const id = input.id.trim()
            const items = readRules()
            const index = items.findIndex((r) => r.id === id)
            if (index === -1) {
              throw new HelmxError('not_found', `Port-forward rule '${id}' not found`, 404, { id })
            }
            const prevRule = items[index]!

            const nodeId = input.nodeId !== undefined ? normalizeNodeId(input.nodeId) : prevRule.nodeId
            const listenHost =
              input.listenHost !== undefined
                ? normalizeHost(input.listenHost, 'listenHost', '127.0.0.1')
                : prevRule.listenHost
            const listenPort =
              input.listenPort !== undefined
                ? normalizePort(input.listenPort, 'listenPort')
                : prevRule.listenPort
            const targetHost =
              input.targetHost !== undefined
                ? normalizeHost(input.targetHost, 'targetHost', '127.0.0.1')
                : prevRule.targetHost
            const targetPort =
              input.targetPort !== undefined
                ? normalizePort(input.targetPort, 'targetPort')
                : prevRule.targetPort
            const enabled = input.enabled !== undefined ? input.enabled : prevRule.enabled
            const name =
              input.name !== undefined
                ? normalizeRuleName(
                    input.name,
                    defaultRuleName(nodeId, listenPort, targetHost, targetPort),
                  )
                : prevRule.name

            if (enabled || input.listenHost !== undefined) {
              assertListenHostAllowed(listenHost, getAllowPublicBind())
            }
            assertNoListenConflict({ listenHost, listenPort }, items, prevRule.id)

            const nextRule: PortForwardRule = {
              ...prevRule,
              name,
              nodeId,
              listenHost,
              listenPort,
              targetHost,
              targetPort,
              enabled,
              updatedAt: Date.now(),
            }

            const endpointChanged =
              prevRule.nodeId !== nextRule.nodeId ||
              prevRule.listenHost !== nextRule.listenHost ||
              prevRule.listenPort !== nextRule.listenPort ||
              prevRule.targetHost !== nextRule.targetHost ||
              prevRule.targetPort !== nextRule.targetPort

            if (!nextRule.enabled) {
              await manager.stopRule(id)
            } else if (endpointChanged || !prevRule.enabled) {
              if (endpointChanged) {
                await manager.stopRule(id)
              }
              try {
                await manager.startRule(nextRule)
              } catch (err) {
                if (prevRule.enabled && endpointChanged) {
                  await manager.startRule(prevRule, { suppressErrorThrow: true })
                }
                throw err
              }
            } else {
              await manager.startRule(nextRule)
            }

            const nextItems = items.map((r, idx) => (idx === index ? nextRule : r))
            await persistRules(nextItems)
            return { item: toViewItem(nextRule) }
          }),
      })

      ctx.action<{ id: string }, { deleted: string }>({
        id: 'delete',
        description: 'Stop any active listener/tunnels for a port-forward rule and delete it permanently',
        exposeToPrompt: false,
        inputSchema: {
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: {
            id: { type: 'string', minLength: 1, description: 'Rule ID to delete' },
          },
        },
        outputSchema: DELETE_OUTPUT_SCHEMA,
        handler: (input) =>
          enqueueWrite(async () => {
            const id = input.id.trim()
            const items = readRules()
            if (!items.some((r) => r.id === id)) {
              throw new HelmxError('not_found', `Port-forward rule '${id}' not found`, 404, { id })
            }
            await manager.stopRule(id, { removeEntry: true })
            await persistRules(items.filter((r) => r.id !== id))
            return { deleted: id }
          }),
      })

      ctx.action<{ id: string }, { item: PortForwardViewItem }>({
        id: 'start',
        description: 'Start listening on a port-forward rule and persist enabled=true',
        exposeToPrompt: false,
        inputSchema: {
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: {
            id: { type: 'string', minLength: 1, description: 'Rule ID to start' },
          },
        },
        outputSchema: MUTATION_OUTPUT_SCHEMA,
        handler: (input) =>
          enqueueWrite(async () => {
            const id = input.id.trim()
            const items = readRules()
            const index = items.findIndex((r) => r.id === id)
            if (index === -1) {
              throw new HelmxError('not_found', `Port-forward rule '${id}' not found`, 404, { id })
            }
            const rule = items[index]!
            assertListenHostAllowed(rule.listenHost, getAllowPublicBind())
            assertNoListenConflict(rule, items, rule.id)
            const nextRule: PortForwardRule = rule.enabled
              ? rule
              : { ...rule, enabled: true, updatedAt: Date.now() }
            await manager.startRule(nextRule)
            if (!rule.enabled) {
              await persistRules(items.map((r, idx) => (idx === index ? nextRule : r)))
            }
            return { item: toViewItem(nextRule) }
          }),
      })

      ctx.action<{ id: string }, { item: PortForwardViewItem }>({
        id: 'stop',
        description: 'Stop listening on a port-forward rule, close active tunnels, and persist enabled=false',
        exposeToPrompt: false,
        inputSchema: {
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: {
            id: { type: 'string', minLength: 1, description: 'Rule ID to stop' },
          },
        },
        outputSchema: MUTATION_OUTPUT_SCHEMA,
        handler: (input) =>
          enqueueWrite(async () => {
            const id = input.id.trim()
            const items = readRules()
            const index = items.findIndex((r) => r.id === id)
            if (index === -1) {
              throw new HelmxError('not_found', `Port-forward rule '${id}' not found`, 404, { id })
            }
            const rule = items[index]!
            await manager.stopRule(id)
            const nextRule: PortForwardRule = rule.enabled
              ? { ...rule, enabled: false, updatedAt: Date.now() }
              : rule
            if (rule.enabled) {
              await persistRules(items.map((r, idx) => (idx === index ? nextRule : r)))
            }
            return { item: toViewItem(nextRule) }
          }),
      })

      ctx.action<Record<string, never>, { stopped: number }>({
        id: 'stop_all',
        description: 'Persistently disable all port-forward rules and close all listeners and active tunnels',
        exposeToPrompt: false,
        cli: { command: ['port-forward', 'stop-all'] },
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        outputSchema: STOP_ALL_OUTPUT_SCHEMA,
        handler: () =>
          enqueueWrite(async () => {
            const items = readRules()
            const now = Date.now()
            let stopped = 0
            const nextItems = items.map((r) => {
              const runtime = manager.getRuntimeEntry(r.id)
              if (r.enabled || runtime.listenerState === 'listening') {
                stopped += 1
              }
              return r.enabled ? { ...r, enabled: false, updatedAt: now } : r
            })
            await Promise.all(items.map((r) => manager.stopRule(r.id)))
            if (nextItems.some((r, idx) => r !== items[idx])) {
              await persistRules(nextItems)
            }
            return { stopped }
          }),
      })

      ctx.action<Record<string, never>, { stoppedListeners: number; closedConnections: number }>({
        id: 'pause_runtime',
        description: 'Close all active Hub listeners and forwarded tunnels in memory without modifying persisted enabled flags',
        exposeToPrompt: false,
        cli: { command: ['port-forward', 'pause-runtime'] },
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        outputSchema: PAUSE_RUNTIME_OUTPUT_SCHEMA,
        handler: () => manager.pauseAllRuntime(),
      })

      const label = { en: 'Port Forwarding', 'zh-CN': '端口映射' }
      ctx.ui.sidebarItem({
        id: 'port-forward-manager',
        label,
        icon: 'network',
        target: `screen:${PORT_FORWARD_PLUGIN_ID}/${PORT_FORWARD_SCREEN_ID}`,
        order: 17,
      })
      ctx.ui.screen({
        id: PORT_FORWARD_SCREEN_ID,
        label,
        icon: 'network',
        client: { module: 'manager.tsx', export: 'PortForwardManagerScreen' },
      })
      ctx.ui.settingsPanel({
        id: 'port-forward-settings',
        label,
        order: 45,
        client: { module: 'settings.tsx', export: 'PortForwardSettingsPanel' },
      })
      ctx.ui.slot({
        id: 'node-port-forwards',
        target: NODE_DETAIL_SECTION_SLOT,
        order: 20,
        client: { module: 'node-slot.tsx', export: 'NodePortForwardsSection' },
      })
    },
  }
}
