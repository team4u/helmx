import React from 'react'
import { Badge, SelectCard, Stack, StatusLight } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { formatUptime } from '../modals/nodes-modal-model.js'
import {
  formatNodePlatformArch,
  getNodeDisplayName,
  isNodeLocal,
  isNodeOnline,
  type NodeInfo,
} from './node-center-model.js'

export interface NodeCardProps {
  node: NodeInfo
  selected?: boolean
  onSelect: () => void
}

/**
 * Compute node card view (NodeCard):
 * - built on SelectCard (<article> + <button aria-pressed> + sibling footer);
 * - header: leading icon block, status pulse indicator (done when online,
 *   idle when offline), node name, local/version badges and mono node ID;
 * - body: supported tool capability badges (bash / read / write / edit, ...);
 * - footer: single-line runtime metadata (platform/arch badge, hostname, uptime);
 * - strictly zero Emoji and Fast Refresh compliant.
 */
export function NodeCard({
  node,
  selected = false,
  onSelect,
}: NodeCardProps): React.JSX.Element {
  const { t } = useWebLocale()
  const isLocal = isNodeLocal(node)
  const isOnline = isNodeOnline(node)
  const displayName = getNodeDisplayName(node, t)
  const platformArch = formatNodePlatformArch(node)
  const iconName = isLocal ? 'laptop' : 'server'
  const version = node.version
    ? (node.version.startsWith('v') ? node.version : `v${node.version}`)
    : null
  const uptime = formatUptime(node.health?.uptimeSec ?? node.uptimeSec)
  const tools =
    Array.isArray(node.tools) && node.tools.length > 0
      ? node.tools
      : ['bash', 'read', 'write', 'edit']

  const hasRuntimeMeta = platformArch !== '--' || Boolean(node.hostname) || uptime !== '--'

  return (
    <SelectCard
      className={`node-card ${isOnline ? 'is-online' : 'is-offline'}`}
      selected={selected}
      onSelect={onSelect}
      data-node-id={node.id}
      icon={iconName}
      title={<span title={displayName}>{displayName}</span>}
      badges={
        <>
          <StatusLight
            tone={isOnline ? 'done' : 'idle'}
            label={isOnline ? t('common.online') : t('common.offline')}
          />
          {isLocal && (
            <Badge tone="neutral" title={t('nodes.localTitle')}>
              {t('nodes.local')}
            </Badge>
          )}
          {version && (
            <Badge tone="neutral" mono title={t('nodes.versionTitle', { version })}>
              {version}
            </Badge>
          )}
        </>
      }
      subtitle={
        <span className="mono break-word" title={node.id}>
          {node.id}
        </span>
      }
      footer={
        hasRuntimeMeta ? (
          <>
            <Stack direction="horizontal" gap="xs" align="center" className="node-card-runtime-meta">
              {platformArch !== '--' && (
                <Badge tone="neutral" mono title={t('nodes.platformTitle')}>
                  {platformArch}
                </Badge>
              )}
              {node.hostname && (
                <span className="mono text-subtle node-card-hostname" title={t('nodes.hostnameTitle', { hostname: node.hostname })}>
                  {node.hostname}
                </span>
              )}
            </Stack>
            {uptime !== '--' && (
              <span className="text-subtle tabular-nums nowrap" title={t('nodes.uptimeTitle', { uptime })}>
                {uptime}
              </span>
            )}
          </>
        ) : undefined
      }
    >
      {/* Body: registered tool capability badges */}
      <Stack direction="horizontal" gap="xs" align="center" wrap>
        {tools.slice(0, 4).map((tool) => (
          <Badge key={tool} tone="neutral" mono icon="terminal" title={t('nodes.cardToolTitle', { tool })}>
            {tool}
          </Badge>
        ))}
        {tools.length > 4 && (
          <Badge
            tone="neutral"
            className="tabular-nums"
            title={t('nodes.moreTools', { count: tools.length - 4 })}
          >
            +{tools.length - 4}
          </Badge>
        )}
      </Stack>
    </SelectCard>
  )
}
