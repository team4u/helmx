/**
 * Display copy for `builtin:port-forward` UI surfaces (pure copy table + builders,
 * no component exports — Fast Refresh friendly; zero Emoji).
 */
import { resolveLocalizedText, type HelmxLocale, type LocalizedText } from '@helmx/ui'
import type { DraftValidationErrorCode, PortForwardViewStatusKind } from './models.ts'

export const PF_SCREEN_TITLE: LocalizedText = { en: 'Port Forwarding', 'zh-CN': '端口映射' }

export const PF_LOADING: LocalizedText = { en: 'Loading port-forward rules…', 'zh-CN': '端口映射规则读取中...' }
export const PF_SEARCH_PLACEHOLDER: LocalizedText = {
  en: 'Search name, node, listen or target endpoint…',
  'zh-CN': '搜索名称、节点、监听或目标地址...',
}
export const PF_FILTER_ALL: LocalizedText = { en: 'All', 'zh-CN': '全部' }
export const PF_FILTER_ACTIVE: LocalizedText = { en: 'Listening', 'zh-CN': '监听中' }
export const PF_FILTER_STOPPED: LocalizedText = { en: 'Stopped', 'zh-CN': '已停止' }
export const PF_FILTER_ERROR: LocalizedText = { en: 'Error', 'zh-CN': '异常' }

export const PF_NEW_MAPPING: LocalizedText = { en: 'New mapping', 'zh-CN': '新建映射' }
export const PF_MORE_ACTIONS: LocalizedText = { en: 'More actions', 'zh-CN': '更多操作' }
export const PF_DISCONNECT_ALL: LocalizedText = { en: 'Pause & disconnect all', 'zh-CN': '断开活动连接' }
export const PF_STOP_ALL: LocalizedText = { en: 'Stop all', 'zh-CN': '全部停止' }
export const PF_CLEAR_NODE_FILTER: LocalizedText = { en: 'Show all nodes', 'zh-CN': '显示全部节点' }
export const PF_RESET_FILTERS: LocalizedText = { en: 'Reset filters', 'zh-CN': '重置筛选' }

export const PF_KV_TOTAL_RULES: LocalizedText = { en: 'Total rules', 'zh-CN': '规则总数' }
export const PF_KV_LISTENING: LocalizedText = { en: 'Listening', 'zh-CN': '监听中' }
export const PF_KV_ACTIVE_CONNS: LocalizedText = { en: 'Active connections', 'zh-CN': '当前连接数' }
export const PF_KV_STATUS: LocalizedText = { en: 'Runtime status', 'zh-CN': '运行状态' }
export const PF_KV_CONNECTIONS: LocalizedText = {
  en: 'Connections (active / total)',
  'zh-CN': '连接数（活跃 / 累计）',
}
export const PF_KV_LAST_ERROR: LocalizedText = { en: 'Last error', 'zh-CN': '最近错误' }

export const PF_EMPTY_TITLE: LocalizedText = { en: 'No port-forward rules yet', 'zh-CN': '暂无端口映射规则' }
export const PF_EMPTY_HINT: LocalizedText = {
  en: 'Use "New mapping" in the top right to forward a Hub port to a compute node service.',
  'zh-CN': '点击右上角「新建映射」，将 Hub 本机端口转发至计算节点服务。',
}
export const PF_FILTER_EMPTY: LocalizedText = {
  en: 'No rules match the current search or filter criteria.',
  'zh-CN': '没有符合当前搜索或筛选条件的规则。',
}

export const PF_COL_STATUS: LocalizedText = { en: 'Status', 'zh-CN': '状态' }
export const PF_COL_CONNS: LocalizedText = { en: 'Connections', 'zh-CN': '连接数' }

export const PF_NODE_OFFLINE: LocalizedText = { en: 'Offline', 'zh-CN': '离线' }
export const PF_NODE_UNKNOWN: LocalizedText = { en: 'Unknown', 'zh-CN': '未知' }
export const PF_NODES_LOADING: LocalizedText = { en: 'Loading nodes…', 'zh-CN': '节点列表加载中...' }
export const PF_NODE_SELECT_PLACEHOLDER: LocalizedText = { en: 'Select a node', 'zh-CN': '选择计算节点' }

export const PF_DELETE: LocalizedText = { en: 'Delete', 'zh-CN': '删除' }
export const PF_CANCEL: LocalizedText = { en: 'Cancel', 'zh-CN': '取消' }
export const PF_SAVE: LocalizedText = { en: 'Save', 'zh-CN': '保存' }
export const PF_CREATE: LocalizedText = { en: 'Create', 'zh-CN': '创建' }
export const PF_TOGGLE_ENABLE: LocalizedText = { en: 'Toggle port-forward rule', 'zh-CN': '启停端口映射规则' }

export const PF_DRAWER_CREATE_TITLE: LocalizedText = { en: 'New port-forward rule', 'zh-CN': '新建端口映射' }
export const PF_DRAWER_EDIT_TITLE: LocalizedText = { en: 'Edit port-forward rule', 'zh-CN': '编辑端口映射' }
export const PF_DRAWER_NOT_FOUND_TITLE: LocalizedText = { en: 'Rule not found', 'zh-CN': '规则不存在' }
export const PF_DRAWER_NOT_FOUND_BODY: LocalizedText = {
  en: 'This port-forward rule may have been deleted or has not finished loading.',
  'zh-CN': '该端口映射规则可能已被删除，或尚未加载完成。',
}

export const PF_FIELD_NAME: LocalizedText = { en: 'Rule name', 'zh-CN': '规则名称' }
export const PF_FIELD_NAME_PLACEHOLDER: LocalizedText = {
  en: 'Optional (auto-generated if blank)',
  'zh-CN': '可选（留空时自动生成）',
}
export const PF_FIELD_NODE: LocalizedText = { en: 'Target node', 'zh-CN': '目标计算节点' }
export const PF_FIELD_NODE_HINT: LocalizedText = {
  en: 'EnvFabric dials target host:port from this node perspective.',
  'zh-CN': '目标主机与端口将在该计算节点的网络视角下解析和连接。',
}
export const PF_FIELD_LISTEN_HOST: LocalizedText = { en: 'Hub listen host', 'zh-CN': 'Hub 监听地址' }
export const PF_FIELD_LISTEN_HOST_HINT: LocalizedText = {
  en: 'Defaults to 127.0.0.1 (loopback only).',
  'zh-CN': '默认 127.0.0.1（仅允许本机访问）。',
}
export const PF_FIELD_LISTEN_PORT: LocalizedText = { en: 'Hub listen port', 'zh-CN': 'Hub 监听端口' }
export const PF_FIELD_TARGET_HOST: LocalizedText = { en: 'Node target host', 'zh-CN': '节点目标地址' }
export const PF_FIELD_TARGET_HOST_HINT: LocalizedText = {
  en: 'Defaults to 127.0.0.1 on the destination node.',
  'zh-CN': '默认连接目标节点的 127.0.0.1。',
}
export const PF_FIELD_TARGET_PORT: LocalizedText = { en: 'Node target port', 'zh-CN': '节点目标端口' }
export const PF_FIELD_ENABLED: LocalizedText = { en: 'Enable and auto-start', 'zh-CN': '启用并随 Hub 自动拉起' }

export const PF_PUBLIC_BIND_WARN_TITLE: LocalizedText = {
  en: 'Non-loopback bind exposes target service',
  'zh-CN': '非回环监听会对外暴露目标服务',
}
export const PF_PUBLIC_BIND_WARN_BODY: LocalizedText = {
  en: 'Binding 0.0.0.0, ::, or a non-loopback address exposes the remote service to reachable networks without adding authentication.',
  'zh-CN': '监听 0.0.0.0、:: 或其他非回环地址会把目标节点服务直接暴露到相应网络，隧道本身不提供应用层认证。',
}
export const PF_PUBLIC_BIND_BLOCKED_HINT: LocalizedText = {
  en: 'Non-loopback bind is currently disabled in plugin settings (allowPublicBind = false). Enable it in Plugin Center before saving.',
  'zh-CN': '当前插件配置已禁止非回环监听（allowPublicBind = false），请先前往插件中心开启后再保存。',
}

export const PF_CONFIRM_DELETE_TITLE: LocalizedText = { en: 'Delete port-forward rule', 'zh-CN': '确认删除端口映射' }
export const PF_CONFIRM_PAUSE_TITLE: LocalizedText = { en: 'Disconnect active tunnels', 'zh-CN': '确认断开全部活动隧道' }
export const PF_CONFIRM_PAUSE_BODY: LocalizedText = {
  en: 'This closes all active Hub listeners and forwarded TCP connections in memory while keeping persisted enabled flags so rules recover on reload/restart.',
  'zh-CN': '此操作会在内存中关闭全部 Hub 监听并断开活动转发连接，同时保留规则的持久化启用状态，便于热重载或重启后自动恢复。',
}
export const PF_CONFIRM_STOP_ALL_TITLE: LocalizedText = { en: 'Stop all port-forward rules', 'zh-CN': '确认停止全部端口映射' }
export const PF_CONFIRM_STOP_ALL_BODY: LocalizedText = {
  en: 'This stops all listeners, disconnects active tunnels, and persists every rule as disabled.',
  'zh-CN': '此操作将停止全部监听、断开当前隧道，并将所有规则持久化设为停用。',
}

export const PF_NODE_SLOT_TITLE: LocalizedText = { en: 'Port Forwarding', 'zh-CN': '端口映射' }
export const PF_NODE_SLOT_EMPTY: LocalizedText = {
  en: 'No port-forward rules target this node yet.',
  'zh-CN': '当前尚无指向该节点的端口映射规则。',
}
export const PF_NODE_SLOT_NEW: LocalizedText = { en: 'New mapping', 'zh-CN': '新建映射' }
export const PF_NODE_SLOT_MANAGE: LocalizedText = { en: 'Manage all', 'zh-CN': '管理全部' }

export const PF_SETTINGS_NOTE: LocalizedText = {
  en: 'Manage Hub-to-node TCP forwarding rules in the Port Forwarding view or via helmx port-forward CLI commands.',
  'zh-CN': '可在端口映射主视图或通过 helmx port-forward CLI 管理 Hub 到计算节点的 TCP 端口映射规则。',
}
export const PF_SETTINGS_ALLOW_PUBLIC: LocalizedText = {
  en: 'Non-loopback bind policy',
  'zh-CN': '非回环绑定策略',
}
export const PF_SETTINGS_ALLOWED: LocalizedText = { en: 'Allowed', 'zh-CN': '已允许' }
export const PF_SETTINGS_DENIED: LocalizedText = { en: 'Loopback only', 'zh-CN': '仅限回环' }
export const PF_OPEN_MANAGER: LocalizedText = { en: 'Open port forwarding', 'zh-CN': '打开端口映射' }

export function pfActiveConnsPill(count: number, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `${count} active`, 'zh-CN': `${count} 活跃连接` },
    locale,
  )
}

export function pfCardConnectionsLabel(
  active: number,
  total: number,
  locale: HelmxLocale,
): string {
  return resolveLocalizedText(
    { en: `${active} active · ${total} total`, 'zh-CN': `${active} 活跃 · 累计 ${total}` },
    locale,
  )
}

export function pfStatusLabel(kind: PortForwardViewStatusKind, locale: HelmxLocale): string {
  switch (kind) {
    case 'active_traffic':
      return resolveLocalizedText({ en: 'Forwarding', 'zh-CN': '转发中' }, locale)
    case 'listening':
      return resolveLocalizedText({ en: 'Listening', 'zh-CN': '监听中' }, locale)
    case 'waiting_node':
      return resolveLocalizedText({ en: 'Port held · node offline', 'zh-CN': '已占端口 · 节点离线' }, locale)
    case 'error':
      return resolveLocalizedText({ en: 'Error', 'zh-CN': '异常' }, locale)
    case 'stopped':
      return resolveLocalizedText({ en: 'Stopped', 'zh-CN': '已停止' }, locale)
  }
}

export function pfValidationErrorMessage(code: DraftValidationErrorCode, locale: HelmxLocale): string {
  switch (code) {
    case 'node_required':
      return resolveLocalizedText({ en: 'Target node is required.', 'zh-CN': '请选择目标计算节点。' }, locale)
    case 'listen_host_invalid':
      return resolveLocalizedText(
        { en: 'Listen host must be a valid IP or hostname (no port suffix or whitespace).', 'zh-CN': '监听地址格式非法（不能含空格或 :端口 后缀）。' },
        locale,
      )
    case 'listen_port_invalid':
      return resolveLocalizedText(
        { en: 'Listen port must be an integer between 1 and 65535 (excluding reserved Hub ports).', 'zh-CN': '监听端口必须是 1-65535 的整数（不可占用 Hub 保留端口）。' },
        locale,
      )
    case 'target_host_invalid':
      return resolveLocalizedText(
        { en: 'Target host must be a valid IP or hostname (no port suffix or whitespace).', 'zh-CN': '目标地址格式非法（不能含空格或 :端口 后缀）。' },
        locale,
      )
    case 'target_port_invalid':
      return resolveLocalizedText(
        { en: 'Target port must be an integer between 1 and 65535.', 'zh-CN': '目标端口必须是 1-65535 的整数。' },
        locale,
      )
    case 'public_bind_disabled':
      return resolveLocalizedText(PF_PUBLIC_BIND_BLOCKED_HINT, locale)
  }
}

export function pfActionFailed(err: unknown, locale: HelmxLocale): string {
  const detail = err instanceof Error ? err.message : String(err)
  return resolveLocalizedText(
    { en: `Operation failed: ${detail}`, 'zh-CN': `操作失败：${detail}` },
    locale,
  )
}

export function pfConfirmDeleteBody(name: string, endpoint: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    {
      en: `Delete rule "${name}" (${endpoint})? Any active listener and tunnels will close immediately.`,
      'zh-CN': `确定删除规则「${name}」（${endpoint}）吗？监听器和活动隧道将立即关闭且无法恢复。`,
    },
    locale,
  )
}

export function pfNodeFilterLabel(nodeId: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `Node: ${nodeId}`, 'zh-CN': `节点：${nodeId}` },
    locale,
  )
}

export function pfRuleCreatedNotice(name: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `Created mapping "${name}"`, 'zh-CN': `已创建映射「${name}」` },
    locale,
  )
}

export function pfRuleUpdatedNotice(name: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `Updated mapping "${name}"`, 'zh-CN': `已更新映射「${name}」` },
    locale,
  )
}

export function pfRuleDeletedNotice(name: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `Deleted mapping "${name}"`, 'zh-CN': `已删除映射「${name}」` },
    locale,
  )
}

export function pfRuleStartedNotice(name: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `Started mapping "${name}"`, 'zh-CN': `已启动映射「${name}」` },
    locale,
  )
}

export function pfRuleStoppedNotice(name: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `Stopped mapping "${name}"`, 'zh-CN': `已停止映射「${name}」` },
    locale,
  )
}

export function pfStoppedAllNotice(count: number, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `Stopped ${count} port-forward rule(s)`, 'zh-CN': `已停止 ${count} 条端口映射规则` },
    locale,
  )
}

export function pfPausedRuntimeNotice(
  stoppedListeners: number,
  closedConnections: number,
  locale: HelmxLocale,
): string {
  return resolveLocalizedText(
    {
      en: `Paused ${stoppedListeners} listener(s) and closed ${closedConnections} connection(s); enabled flags preserved`,
      'zh-CN': `已临时关闭 ${stoppedListeners} 个监听并断开 ${closedConnections} 条连接，启用状态已保留`,
    },
    locale,
  )
}
