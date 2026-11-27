import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  DetailDrawer,
  EmptyState,
  Field,
  HelmxIcon,
  Input,
  KvGrid,
  MonoId,
  PluginSlot,
  Stack,
} from '@helmx/plugin-client'
import { nodesApi } from '../lib/api.js'
import { useOptionalNodes } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  buildNodeConnectGuide,
  formatBytes,
  formatHubEndpointTag,
  formatUptime,
  formatUsage,
  isLoopbackHubUrl,
  resolveHubEndpointOptions,
  validateNodeIdInput,
} from '../modals/nodes-modal-model.js'
import {
  getNodeDisplayName,
  isNodeLocal,
  isNodeOnline,
  type NodeInfo,
} from './node-center-model.js'
import { NODE_DETAIL_SECTION_SLOT, type HubAccessInfo, type NodeUpgradeCheckResult } from '@helmx/protocol/browser'
import { CopyableCommandRow, MonoValue, NodeSectionTitle } from './node-detail/NodeDetailPrimitives.js'

export interface NodeDetailDrawerProps {
  node: NodeInfo | null
  open: boolean
  onClose: () => void
  /** Render inline (uniform assertions for tests and SSR). */
  inline?: boolean
  /** Whether the drawer is in the new-node enrollment mode. */
  isNew?: boolean
  /** Optional Hub reachable address summary override (defaults to `local` node `hubAccess`). */
  hubAccess?: HubAccessInfo
  onTokenIssued?: (token: string) => void
  onRefresh?: () => Promise<unknown> | void
}

/**
 * Right slide-over drawer of the full-screen Compute Nodes Center
 * (NodeDetailDrawer):
 * - built on Radix Dialog primitives as a 520px-560px drawer;
 * - header: node icon, friendly name, online badge, mono node ID and a close
 *   button;
 * - node system overview: OS, CPU architecture, Node version, hostname,
 *   working directory, connection channel, uptime;
 * - node health check: check trigger button, CPU load, memory and disk
 *   capacity figures, version diagnostics;
 * - remote node enrollment & commands: issue an access token (via
 *   nodesApi.issueToken), one-click copy of the enrollment command line with
 *   copy feedback;
 * - registered tool capability list: the bash / read / write / edit vector;
 * - plugin extension slot: existing nodes mount builtin:node/detail-section
 *   after the system overview (other plugins inject node-scoped sections;
 *   only the public node snapshot is passed — never enrollment tokens or
 *   other credentials);
 * - strictly zero Emoji and Fast Refresh compliant.
 */
export function NodeDetailDrawer({
  node,
  open,
  onClose,
  inline = false,
  isNew = false,
  hubAccess: hubAccessProp,
  onTokenIssued,
  onRefresh,
}: NodeDetailDrawerProps): React.JSX.Element {
  const { t } = useWebLocale()
  const storeNodes = useOptionalNodes()
  const [issuedTokenState, setIssuedTokenState] = useState<{ nodeId: string; token: string } | null>(null)
  const [issuedHubAccess, setIssuedHubAccess] = useState<HubAccessInfo | null>(null)
  const [newNodeId, setNewNodeId] = useState('')
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [issuing, setIssuing] = useState(false)
  const [selectedEndpointUrl, setSelectedEndpointUrl] = useState<string | null>(null)
  const [customMode, setCustomMode] = useState(false)
  const [customHubUrl, setCustomHubUrl] = useState('')
  const [showMoreEndpoints, setShowMoreEndpoints] = useState(false)

  const [checkingHealth, setCheckingHealth] = useState(false)
  const [healthState, setHealthState] = useState<{ nodeId: string; result: NodeUpgradeCheckResult } | null>(null)
  const [healthErrorState, setHealthErrorState] = useState<{ nodeId: string; message: string } | null>(null)

  const mountedRef = useRef(true)
  const tokenGenerationRef = useRef(0)
  const healthGenerationRef = useRef(0)

  const isLocal = node ? isNodeLocal(node) : false
  const isOnline = node ? isNodeOnline(node) : false
  const displayName = isNew
    ? t('nodes.drawer.newTitle')
    : node
      ? getNodeDisplayName(node, t)
      : t('nodes.drawer.titleFallback')
  const iconName = isLocal ? 'laptop' : 'server'

  const rawOrigin = typeof window !== 'undefined' ? window.location?.origin : undefined
  const localHubAccess = useMemo(
    () => storeNodes?.find((n) => n.id === 'local' || n.kind === 'local')?.hubAccess,
    [storeNodes],
  )
  const effectiveHubAccess = issuedHubAccess ?? hubAccessProp ?? localHubAccess

  const resolvedEndpoints = useMemo(
    () =>
      resolveHubEndpointOptions({
        hubAccess: effectiveHubAccess,
        browserOrigin: rawOrigin,
        preferredUrl: !isNew ? node?.hubUrl : undefined,
      }),
    [effectiveHubAccess, rawOrigin, isNew, node?.hubUrl],
  )

  const activeEndpointUrl = useMemo(() => {
    if (
      selectedEndpointUrl !== null &&
      resolvedEndpoints.all.some((opt) => opt.url === selectedEndpointUrl)
    ) {
      return selectedEndpointUrl
    }
    return resolvedEndpoints.defaultUrl
  }, [selectedEndpointUrl, resolvedEndpoints])

  const effectiveHubUrl = customMode
    ? customHubUrl.trim() || resolvedEndpoints.defaultUrl
    : activeEndpointUrl

  const isLoopbackEffective =
    effectiveHubUrl !== '<HUB_URL>' && isLoopbackHubUrl(effectiveHubUrl)

  const targetNodeId = isNew ? newNodeId.trim() : node?.id ?? ''
  const issuedToken =
    open && targetNodeId !== '' && issuedTokenState !== null && issuedTokenState.nodeId === targetNodeId
      ? issuedTokenState.token
      : null
  const healthResult =
    open && !isNew && node?.id && healthState !== null && healthState.nodeId === node.id
      ? healthState.result
      : null
  const healthError =
    open && !isNew && node?.id && healthErrorState !== null && healthErrorState.nodeId === node.id
      ? healthErrorState.message
      : null

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      tokenGenerationRef.current += 1
      healthGenerationRef.current += 1
    }
  }, [])

  // Clear one-time token state and invalidate in-flight token requests whenever
  // the target node, enrollment mode, or drawer visibility changes.
  useEffect(() => {
    tokenGenerationRef.current += 1
    setIssuedTokenState(null)
    setTokenError(null)
    setIssuing(false)
  }, [open, isNew, targetNodeId])

  useEffect(() => {
    healthGenerationRef.current += 1
    setHealthState(null)
    setHealthErrorState(null)
    setCheckingHealth(false)
    setIssuedHubAccess(null)
    setSelectedEndpointUrl(null)
    setCustomMode(false)
    setCustomHubUrl('')
    setShowMoreEndpoints(false)
    if (!open || !isNew) {
      setNewNodeId('')
    }
  }, [open, isNew, node?.id])

  const guide = targetNodeId
    ? buildNodeConnectGuide(effectiveHubUrl, {
        nodeId: targetNodeId,
        token: issuedToken || '<TOKEN>',
      })
    : null

  const handleIssueToken = async () => {
    if (isNew) {
      const validation = validateNodeIdInput(newNodeId, t)
      if (!validation.ok) {
        setTokenError(validation.error)
        return
      }
    }

    const requestedNodeId = targetNodeId
    if (!requestedNodeId) {
      setTokenError(t('nodes.drawer.invalidNodeId'))
      return
    }

    const generation = ++tokenGenerationRef.current
    setIssuing(true)
    setTokenError(null)

    try {
      const res = await nodesApi.issueToken(requestedNodeId)
      if (!mountedRef.current || tokenGenerationRef.current !== generation) return
      setIssuedTokenState({ nodeId: requestedNodeId, token: res.token })
      if (res.hubAccess !== undefined) {
        setIssuedHubAccess(res.hubAccess)
      }
      if (onTokenIssued) {
        onTokenIssued(res.token)
      }
      if (onRefresh) {
        await onRefresh()
      }
    } catch (err) {
      if (!mountedRef.current || tokenGenerationRef.current !== generation) return
      setTokenError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current && tokenGenerationRef.current === generation) {
        setIssuing(false)
      }
    }
  }

  const handleHealthCheck = async () => {
    const requestedNodeId = node?.id
    if (!requestedNodeId) return
    const generation = ++healthGenerationRef.current
    setCheckingHealth(true)
    setHealthErrorState(null)

    try {
      const res = await nodesApi.checkUpgrade(requestedNodeId)
      if (!mountedRef.current || healthGenerationRef.current !== generation) return
      setHealthState({ nodeId: requestedNodeId, result: res })
    } catch (err) {
      if (!mountedRef.current || healthGenerationRef.current !== generation) return
      setHealthErrorState({
        nodeId: requestedNodeId,
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      if (mountedRef.current && healthGenerationRef.current === generation) {
        setCheckingHealth(false)
      }
    }
  }

  const health = node?.health
  const memUsage = health ? formatUsage(health.memFreeBytes, health.memTotalBytes, t) : null
  const diskUsage = health ? formatUsage(health.diskFreeBytes, health.diskTotalBytes, t) : null
  const uptime = formatUptime(health?.uptimeSec ?? node?.uptimeSec)
  const tools =
    Array.isArray(node?.tools) && node.tools.length > 0
      ? node.tools
      : ['bash', 'read', 'write', 'edit']

  return (
    <DetailDrawer
      open={open}
      inline={inline}
      onClose={onClose}
      title={displayName}
      titleClassName="break-word"
      titleExtra={
        <>
          {!isNew && (
            <Badge
              tone={isOnline ? 'ok' : 'neutral'}
              icon={isOnline ? 'check' : 'circle'}
            >
              {isOnline ? t('common.online') : t('common.offline')}
            </Badge>
          )}
          {isLocal && (
            <Badge tone="neutral">{t('nodes.local')}</Badge>
          )}
          {node?.version && (
            <Badge tone="neutral" mono>
              {node.version.startsWith('v') ? node.version : `v${node.version}`}
            </Badge>
          )}
        </>
      }
      meta={!isNew && node?.id ? <MonoId value={node.id} /> : undefined}
      metaClassName="text-subtle break-word"
      icon={<HelmxIcon name={iconName} size={22} />}
      aria-label={displayName}
      closeLabel={t('common.close')}
      footer={
        <Button size="sm" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      {!node && !isNew ? (
        <EmptyState title={t('nodes.drawer.noSelection')} />
      ) : (
        <>
          {/* 1. Node system overview */}
          {!isNew && node && (
            <Card
              variant="subtle"
              title={<NodeSectionTitle icon="cpu" label={t('nodes.drawer.overview')} />}
            >
              <KvGrid
                items={[
                  {
                    key: t('nodes.drawer.os'),
                    value: <MonoValue>{node.os || node.platform || '--'}</MonoValue>,
                  },
                  {
                    key: t('nodes.drawer.arch'),
                    value: <MonoValue>{node.arch || '--'}</MonoValue>,
                  },
                  {
                    key: t('nodes.drawer.version'),
                    value: <MonoValue>{node.version || '--'}</MonoValue>,
                  },
                  {
                    key: t('nodes.drawer.hostname'),
                    value: <MonoValue>{node.hostname || '--'}</MonoValue>,
                  },
                  {
                    key: t('nodes.drawer.cwd'),
                    value: <MonoValue>{node.cwd || '--'}</MonoValue>,
                  },
                  {
                    key: t('nodes.drawer.channel'),
                    value: <MonoValue>{node.hubUrl || (isLocal ? t('nodes.drawer.localIpc') : '--')}</MonoValue>,
                  },
                  {
                    key: t('nodes.drawer.uptime'),
                    value: <MonoValue>{uptime}</MonoValue>,
                  },
                ]}
              />
            </Card>
          )}

          {/* 1.5 Plugin extension slots (other plugins inject node sections into builtin:node/detail-section) */}
          {!isNew && node && (
            <PluginSlot
              ownerPluginId="builtin:node"
              name={NODE_DETAIL_SECTION_SLOT}
              slotProps={{
                nodeId: node.id,
                isLocal,
                isOnline,
                isNew: false,
              }}
            />
          )}

          {/* 2. Node health check */}
          {!isNew && node && (
            <Card
              variant="subtle"
              title={<NodeSectionTitle icon="activity" label={t('nodes.drawer.healthSection')} />}
              actions={
                <Button
                  size="sm"
                  icon="activity"
                  pending={checkingHealth}
                  onClick={() => void handleHealthCheck()}
                >
                  {checkingHealth ? t('nodes.drawer.checking') : t('nodes.drawer.healthAction')}
                </Button>
              }
            >
              <KvGrid
                items={[
                  {
                    key: t('nodes.drawer.cpuUsage'),
                    value: (
                      <MonoValue>
                        {health?.cpuUsagePercent !== undefined
                          ? `${health.cpuUsagePercent}%`
                          : '--'}
                      </MonoValue>
                    ),
                  },
                  {
                    key: t('nodes.drawer.systemLoad'),
                    value: (
                      <MonoValue>
                        {health?.loadAvg
                          ? `${health.loadAvg[0]?.toFixed(2) ?? '--'} / ${health.loadAvg[1]?.toFixed(2) ?? '--'} / ${health.loadAvg[2]?.toFixed(2) ?? '--'}`
                          : health?.load1 !== undefined
                            ? `${health.load1} / ${health.load5 ?? '--'} / ${health.load15 ?? '--'}`
                            : '--'}
                      </MonoValue>
                    ),
                  },
                  {
                    key: t('nodes.drawer.memUsage'),
                    value: (
                      <MonoValue>
                        {memUsage?.label ??
                          (health?.memTotalBytes !== undefined
                            ? formatBytes(health.memTotalBytes)
                            : '--')}
                      </MonoValue>
                    ),
                  },
                  {
                    key: t('nodes.drawer.diskSpace'),
                    value: (
                      <MonoValue>
                        {diskUsage?.label ??
                          (health?.diskTotalBytes !== undefined
                            ? formatBytes(health.diskTotalBytes)
                            : '--')}
                      </MonoValue>
                    ),
                  },
                ]}
              />

              {healthResult && (
                <Callout tone={healthResult.updateAvailable ? 'warn' : 'ok'}>
                  <span className="callout-text" role="status">
                    {healthResult.updateAvailable
                      ? t('nodes.drawer.updateAvailable', { version: healthResult.latestVersion })
                      : t('nodes.drawer.upToDate')}
                  </span>
                </Callout>
              )}

              {healthError && (
                <Callout tone="err">
                  <span className="callout-text" role="alert">{healthError}</span>
                </Callout>
              )}
            </Card>
          )}

          {/* 3. Remote node access token and start command (when the node is remote or used to enroll a new node) */}
          {(!isLocal || isNew) && (
            <Card
              variant="subtle"
              className="border-accent"
              title={<NodeSectionTitle icon="key" label={t('nodes.drawer.enrollSection')} />}
            >
              {isNew && (
                <Field
                  label={t('nodes.drawer.nodeId')}
                  htmlFor="new-node-id-input"
                  layout="horizontal"
                >
                  <Input
                    mono
                    invalid={tokenError !== null}
                    placeholder={t('nodes.drawer.nodeIdPlaceholder')}
                    value={newNodeId}
                    onChange={(e) => setNewNodeId(e.target.value)}
                  />
                </Field>
              )}

              <Stack direction="horizontal" gap="sm" align="center">
                <Button
                  variant="primary"
                  size="sm"
                  icon="key"
                  pending={issuing}
                  disabled={isNew && !newNodeId.trim()}
                  onClick={() => void handleIssueToken()}
                >
                  {issuedToken ? t('nodes.drawer.reissueToken') : t('nodes.drawer.issueToken')}
                </Button>
              </Stack>

              {tokenError && (
                <Callout tone="err">
                  <span className="callout-text" role="alert">{tokenError}</span>
                </Callout>
              )}

              {issuedToken && (
                <Stack direction="vertical" gap="xs">
                  <div className="text-subtle">{t('nodes.drawer.tokenLabel')}</div>
                  <CopyableCommandRow text={issuedToken} label={t('nodes.drawer.copyToken')} />
                </Stack>
              )}

              {guide && (
                <Stack direction="vertical" gap="xs">
                  <div className="text-subtle">{t('nodes.drawer.installLabel')}</div>
                  <CopyableCommandRow text={guide.installCommand} label={t('nodes.drawer.copyCommand')} />

                  <div className="text-subtle">{t('nodes.drawer.oneLineLabel')}</div>
                  <div className="node-endpoint-picker">
                    <div className="node-endpoint-header">
                      <span className="text-subtle">{t('nodes.drawer.hubUrlLabel')}</span>
                      {resolvedEndpoints.listenSummary && (
                        <span className="node-endpoint-listen mono">
                          {t('nodes.drawer.listenSummary', { addr: resolvedEndpoints.listenSummary })}
                        </span>
                      )}
                    </div>
                    <div className="node-endpoint-chips" role="group" aria-label={t('nodes.drawer.hubUrlLabel')}>
                      {(showMoreEndpoints ? resolvedEndpoints.all : resolvedEndpoints.primary).map((opt) => {
                        const selected = !customMode && activeEndpointUrl === opt.url
                        return (
                          <button
                            key={opt.url}
                            type="button"
                            className={`node-endpoint-chip${selected ? ' is-active' : ''}`}
                            aria-pressed={selected}
                            onClick={() => {
                              setCustomMode(false)
                              setSelectedEndpointUrl(opt.url)
                            }}
                          >
                            <span className="node-endpoint-chip-host">{opt.displayLabel}</span>
                            <span className="node-endpoint-chip-tag">
                              {formatHubEndpointTag(opt, t)}
                            </span>
                          </button>
                        )
                      })}
                      {resolvedEndpoints.more.length > 0 && (
                        <button
                          type="button"
                          className="node-endpoint-chip"
                          aria-expanded={showMoreEndpoints}
                          onClick={() => setShowMoreEndpoints((v) => !v)}
                        >
                          <HelmxIcon name={showMoreEndpoints ? 'chevron-up' : 'chevron-down'} size={12} />
                          <span>
                            {showMoreEndpoints
                              ? t('nodes.drawer.lessEndpoints')
                              : t('nodes.drawer.moreEndpoints', { count: resolvedEndpoints.more.length })}
                          </span>
                        </button>
                      )}
                      <button
                        type="button"
                        className={`node-endpoint-chip${customMode ? ' is-active' : ''}`}
                        aria-pressed={customMode}
                        onClick={() => {
                          if (!customMode) {
                            setCustomHubUrl((prev) => prev || activeEndpointUrl)
                            setCustomMode(true)
                          } else {
                            setCustomMode(false)
                          }
                        }}
                      >
                        <HelmxIcon name="edit" size={12} />
                        <span>{t('nodes.drawer.customEndpoint')}</span>
                      </button>
                    </div>
                    {customMode && (
                      <Input
                        mono
                        aria-label={t('nodes.drawer.customEndpointAria')}
                        placeholder={t('nodes.drawer.customEndpointPlaceholder')}
                        value={customHubUrl}
                        onChange={(e) => setCustomHubUrl(e.target.value)}
                      />
                    )}
                    {isLoopbackEffective && (
                      <Callout tone="warn">
                        <span className="callout-text">
                          {effectiveHubAccess?.loopbackOnly
                            ? t('nodes.drawer.loopbackOnlyWarning')
                            : t('nodes.drawer.loopbackSelectedWarning')}
                        </span>
                      </Callout>
                    )}
                  </div>
                  <CopyableCommandRow text={guide.oneLineCommand} label={t('nodes.drawer.copyCommand')} />

                  <div className="text-subtle">
                    {t('nodes.drawer.maintenanceLabel')}
                  </div>
                  <CopyableCommandRow text={guide.startDaemonCommand} />
                  <CopyableCommandRow text={guide.serviceInstallCommand} />
                  <CopyableCommandRow text={guide.doctorCommand} />
                </Stack>
              )}
            </Card>
          )}

          {/* 4. Registered tool capabilities */}
          {!isNew && (
            <Card
              variant="subtle"
              title={<NodeSectionTitle icon="wrench" label={t('nodes.drawer.toolsSection')} />}
            >
              <Stack direction="horizontal" gap="xs" align="center" wrap className="primary-card-pills">
                {tools.map((tool) => (
                  <Badge
                    key={tool}
                    tone="neutral"
                    mono
                    icon="terminal"
                    title={t('nodes.drawer.toolTitle', { tool })}
                  >
                    {tool}
                  </Badge>
                ))}
              </Stack>
            </Card>
          )}
        </>
      )}
    </DetailDrawer>
  )
}
