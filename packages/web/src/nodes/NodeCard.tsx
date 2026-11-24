import React from 'react'
import { Badge, HelmxIcon, SelectCard, Stack, StatusLight } from '@helmx/plugin-client'
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
 * - middle: platform/OS and CPU architecture badge, hostname and host uptime;
 * - bottom: supported tool capability badges (bash / read / write / edit, ...);
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

  return (
    <SelectCard
      className={`node-card ${isOnline ? 'is-online' : 'is-offline'}`}
      selected={selected}
      onSelect={onSelect}
      data-node-id={node.id}
      title={
        <span className="primary-card-head-with-icon">
          <span className="primary-card-icon-wrap" aria-hidden="true">
            <HelmxIcon name={iconName} size={18} />
          </span>
          <span className="primary-card-meta">
            <span className="primary-card-title-row">
              <StatusLight
                tone={isOnline ? 'done' : 'idle'}
                label={isOnline ? t('common.online') : t('common.offline')}
              />
              <span className="primary-card-name" title={displayName}>
                {displayName}
              </span>
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
            </span>
            <span className="primary-card-id mono text-subtle break-word" title={node.id}>
              {node.id}
            </span>
          </span>
        </span>
      }
      footer={
        <Stack direction="horizontal" gap="xs" align="center" wrap className="primary-card-pills">
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
      }
    >
      {/* Middle: platform, architecture and runtime overview */}
      <Stack direction="horizontal" gap="xs" align="center" wrap>
        {platformArch !== '--' && (
          <Badge tone="neutral" mono title={t('nodes.platformTitle')}>
            {platformArch}
          </Badge>
        )}
        {node.hostname && (
          <span className="mono text-subtle break-word" title={t('nodes.hostnameTitle', { hostname: node.hostname })}>
            {node.hostname}
          </span>
        )}
        {uptime !== '--' && (
          <span className="text-subtle" title={t('nodes.uptimeTitle', { uptime })}>
            {uptime}
          </span>
        )}
      </Stack>
    </SelectCard>
  )
}
