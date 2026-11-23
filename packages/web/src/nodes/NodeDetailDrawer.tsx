import React, { useEffect, useRef, useState } from 'react'
import { copyToClipboard, CopyButton, DetailDrawer, HelmxIcon, PluginSlot } from '@helmx/plugin-client'
import { nodesApi } from '../lib/api.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  buildNodeConnectGuide,
  formatBytes,
  formatUptime,
  formatUsage,
  validateNodeIdInput,
} from '../modals/nodes-modal-model.js'
import {
  getNodeDisplayName,
  isNodeLocal,
  isNodeOnline,
  type NodeInfo,
} from './node-center-model.js'
import { NODE_DETAIL_SECTION_SLOT, type NodeUpgradeCheckResult } from '@helmx/protocol/browser'

export interface NodeDetailDrawerProps {
  node: NodeInfo | null
  open: boolean
  onClose: () => void
  /** Render inline (uniform assertions for tests and SSR). */
  inline?: boolean
  /** Whether the drawer is in the new-node enrollment mode. */
  isNew?: boolean
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
  onTokenIssued,
  onRefresh,
}: NodeDetailDrawerProps): React.JSX.Element {
  const { t } = useWebLocale()
  const [issuedTokenState, setIssuedTokenState] = useState<{ nodeId: string; token: string } | null>(null)
  const [newNodeId, setNewNodeId] = useState('')
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [issuing, setIssuing] = useState(false)
  const [copiedCmd, setCopiedCmd] = useState(false)
  const [copiedToken, setCopiedToken] = useState(false)

  const [checkingHealth, setCheckingHealth] = useState(false)
  const [healthState, setHealthState] = useState<{ nodeId: string; result: NodeUpgradeCheckResult } | null>(null)
  const [healthErrorState, setHealthErrorState] = useState<{ nodeId: string; message: string } | null>(null)

  const mountedRef = useRef(true)
  const tokenGenerationRef = useRef(0)
  const healthGenerationRef = useRef(0)
  const copiedCmdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copiedTokenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isLocal = node ? isNodeLocal(node) : false
  const isOnline = node ? isNodeOnline(node) : false
  const displayName = isNew
    ? t('nodes.drawer.newTitle')
    : node
      ? getNodeDisplayName(node, t)
      : t('nodes.drawer.titleFallback')
  const iconName = isLocal ? 'laptop' : 'server'

  const hubOrigin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost:3202'

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
      if (copiedCmdTimerRef.current !== null) {
        clearTimeout(copiedCmdTimerRef.current)
        copiedCmdTimerRef.current = null
      }
      if (copiedTokenTimerRef.current !== null) {
        clearTimeout(copiedTokenTimerRef.current)
        copiedTokenTimerRef.current = null
      }
    }
  }, [])

  // Clear one-time token state and invalidate in-flight token requests whenever
  // the target node, enrollment mode, or drawer visibility changes.
  useEffect(() => {
    tokenGenerationRef.current += 1
    setIssuedTokenState(null)
    setTokenError(null)
    setIssuing(false)
    setCopiedCmd(false)
    setCopiedToken(false)
    if (copiedCmdTimerRef.current !== null) {
      clearTimeout(copiedCmdTimerRef.current)
      copiedCmdTimerRef.current = null
    }
    if (copiedTokenTimerRef.current !== null) {
      clearTimeout(copiedTokenTimerRef.current)
      copiedTokenTimerRef.current = null
    }
  }, [open, isNew, targetNodeId])

  useEffect(() => {
    healthGenerationRef.current += 1
    setHealthState(null)
    setHealthErrorState(null)
    setCheckingHealth(false)
    if (!open || !isNew) {
      setNewNodeId('')
    }
  }, [open, isNew, node?.id])

  const guide = targetNodeId
    ? buildNodeConnectGuide(hubOrigin, {
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

  const handleCopyCmd = async () => {
    if (!guide) return
    const generation = tokenGenerationRef.current
    const ok = await copyToClipboard(guide.oneLineCommand)
    if (!mountedRef.current || tokenGenerationRef.current !== generation) return
    if (ok) {
      setCopiedCmd(true)
      if (copiedCmdTimerRef.current !== null) clearTimeout(copiedCmdTimerRef.current)
      copiedCmdTimerRef.current = setTimeout(() => {
        copiedCmdTimerRef.current = null
        if (mountedRef.current && tokenGenerationRef.current === generation) {
          setCopiedCmd(false)
        }
      }, 2000)
    }
  }

  const handleCopyToken = async () => {
    if (!issuedToken) return
    const generation = tokenGenerationRef.current
    const ok = await copyToClipboard(issuedToken)
    if (!mountedRef.current || tokenGenerationRef.current !== generation) return
    if (ok) {
      setCopiedToken(true)
      if (copiedTokenTimerRef.current !== null) clearTimeout(copiedTokenTimerRef.current)
      copiedTokenTimerRef.current = setTimeout(() => {
        copiedTokenTimerRef.current = null
        if (mountedRef.current && tokenGenerationRef.current === generation) {
          setCopiedToken(false)
        }
      }, 2000)
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
            <span
              className={`badge ${isOnline ? 'badge-ok' : 'badge-neutral'}`}
            >
              <HelmxIcon name={isOnline ? 'check' : 'circle'} size={10} />
              <span>{isOnline ? t('common.online') : t('common.offline')}</span>
            </span>
          )}
          {isLocal && (
            <span className="badge badge-neutral">{t('nodes.local')}</span>
          )}
          {node?.version && (
            <span className="badge badge-neutral mono">
              {node.version.startsWith('v') ? node.version : `v${node.version}`}
            </span>
          )}
        </>
      }
      meta={!isNew && node?.id ? node.id : undefined}
      metaClassName="text-subtle break-word"
      icon={<HelmxIcon name={iconName} size={22} />}
      aria-label={displayName}
      closeLabel={t('common.close')}
      footer={
        <button type="button" className="btn btn-sm" onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
            {!node && !isNew ? (
              <div className="primary-center-empty">{t('nodes.drawer.noSelection')}</div>
            ) : (
              <>
                {/* 1. Node system overview */}
                {!isNew && node && (
                  <section className="section-flat">
                    <div className="section-flat-header">
                      <HelmxIcon name="cpu" size={13} />
                      <span className="section-flat-title">{t('nodes.drawer.overview')}</span>
                    </div>

                    <div className="form-grid">
                      <span className="form-grid-label">{t('nodes.drawer.os')}</span>
                      <span className="mono selectable form-grid-value">
                        {node.os || node.platform || '--'}
                      </span>

                      <span className="form-grid-label">{t('nodes.drawer.arch')}</span>
                      <span className="mono selectable form-grid-value">
                        {node.arch || '--'}
                      </span>

                      <span className="form-grid-label">{t('nodes.drawer.version')}</span>
                      <span className="mono selectable form-grid-value">
                        {node.version || '--'}
                      </span>

                      <span className="form-grid-label">{t('nodes.drawer.hostname')}</span>
                      <span className="mono selectable form-grid-value">
                        {node.hostname || '--'}
                      </span>

                      <span className="form-grid-label">{t('nodes.drawer.cwd')}</span>
                      <span className="mono selectable form-grid-value">
                        {node.cwd || '--'}
                      </span>

                      <span className="form-grid-label">{t('nodes.drawer.channel')}</span>
                      <span className="mono selectable form-grid-value">
                        {node.hubUrl || (isLocal ? t('nodes.drawer.localIpc') : '--')}
                      </span>

                      <span className="form-grid-label">{t('nodes.drawer.uptime')}</span>
                      <span className="mono selectable form-grid-value">{uptime}</span>
                    </div>
                  </section>
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
                  <section className="section-flat">
                    <div className="section-flat-header flex-row-between">
                      <div className="flex-row">
                        <HelmxIcon name="activity" size={13} />
                        <span className="section-flat-title">{t('nodes.drawer.healthSection')}</span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={checkingHealth}
                        onClick={() => void handleHealthCheck()}
                      >
                        <HelmxIcon name="activity" size={12} />
                        <span>{checkingHealth ? t('nodes.drawer.checking') : t('nodes.drawer.healthAction')}</span>
                      </button>
                    </div>

                    <div className="form-grid">
                      <span className="form-grid-label">{t('nodes.drawer.cpuUsage')}</span>
                      <span className="mono selectable form-grid-value">
                        {health?.cpuUsagePercent !== undefined
                          ? `${health.cpuUsagePercent}%`
                          : '--'}
                      </span>

                      <span className="form-grid-label">{t('nodes.drawer.systemLoad')}</span>
                      <span className="mono selectable form-grid-value">
                        {health?.loadAvg
                          ? `${health.loadAvg[0]?.toFixed(2) ?? '--'} / ${health.loadAvg[1]?.toFixed(2) ?? '--'} / ${health.loadAvg[2]?.toFixed(2) ?? '--'}`
                          : health?.load1 !== undefined
                            ? `${health.load1} / ${health.load5 ?? '--'} / ${health.load15 ?? '--'}`
                            : '--'}
                      </span>

                      <span className="form-grid-label">{t('nodes.drawer.memUsage')}</span>
                      <span className="mono selectable form-grid-value">
                        {memUsage?.label ??
                          (health?.memTotalBytes !== undefined
                            ? formatBytes(health.memTotalBytes)
                            : '--')}
                      </span>

                      <span className="form-grid-label">{t('nodes.drawer.diskSpace')}</span>
                      <span className="mono selectable form-grid-value">
                        {diskUsage?.label ??
                          (health?.diskTotalBytes !== undefined
                            ? formatBytes(health.diskTotalBytes)
                            : '--')}
                      </span>
                    </div>

                    {healthResult && (
                      <div
                        className={`callout ${healthResult.updateAvailable ? 'callout-warn' : 'callout-ok'}`}
                        role="status"
                      >
                        <HelmxIcon
                          name={healthResult.updateAvailable ? 'alert-triangle' : 'check'}
                          size={13}
                        />
                        <span className="callout-text">
                          {healthResult.updateAvailable
                            ? t('nodes.drawer.updateAvailable', { version: healthResult.latestVersion })
                            : t('nodes.drawer.upToDate')}
                        </span>
                      </div>
                    )}

                    {healthError && (
                      <div className="callout callout-error" role="alert">
                        <HelmxIcon name="alert-circle" size={13} />
                        <span className="callout-text">{healthError}</span>
                      </div>
                    )}
                  </section>
                )}

                {/* 3. Remote node access token and start command (when the node is remote or used to enroll a new node) */}
                {(!isLocal || isNew) && (
                  <section className="section-flat border-accent">
                    <div className="section-flat-header">
                      <HelmxIcon name="key" size={13} />
                      <span className="section-flat-title">{t('nodes.drawer.enrollSection')}</span>
                    </div>

                    {isNew && (
                      <div className="form-grid">
                        <label htmlFor="new-node-id-input" className="form-grid-label">
                          {t('nodes.drawer.nodeId')}
                        </label>
                        <input
                          id="new-node-id-input"
                          type="text"
                          className="input mono"
                          placeholder={t('nodes.drawer.nodeIdPlaceholder')}
                          value={newNodeId}
                          onChange={(e) => setNewNodeId(e.target.value)}
                        />
                      </div>
                    )}

                    <div className="flex-row">
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={issuing || (isNew && !newNodeId.trim())}
                        onClick={() => void handleIssueToken()}
                      >
                        <HelmxIcon name="key" size={12} />
                        <span>{issuedToken ? t('nodes.drawer.reissueToken') : t('nodes.drawer.issueToken')}</span>
                      </button>
                    </div>

                    {tokenError && (
                      <div className="callout callout-error" role="alert">
                        <HelmxIcon name="alert-circle" size={13} />
                        <span className="callout-text">{tokenError}</span>
                      </div>
                    )}

                    {issuedToken && (
                      <div className="flex-col">
                        <div className="text-subtle">{t('nodes.drawer.tokenLabel')}</div>
                        <div className="flex-row flex-row-wrap">
                          <code className="code-box selectable flex-1 mono">
                            {issuedToken}
                          </code>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => void handleCopyToken()}
                            title={t('nodes.drawer.copyToken')}
                          >
                            <HelmxIcon name={copiedToken ? 'check' : 'copy'} size={12} />
                            <span>{copiedToken ? t('nodes.drawer.copied') : t('nodes.drawer.copyToken')}</span>
                          </button>
                        </div>
                      </div>
                    )}

                    {guide && (
                      <div className="flex-col">
                        <div className="text-subtle">{t('nodes.drawer.oneLineLabel')}</div>
                        <div className="flex-row flex-row-wrap">
                          <code className="code-box selectable flex-1 mono">
                            {guide.oneLineCommand}
                          </code>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => void handleCopyCmd()}
                            title={t('nodes.drawer.copyCommandTitle')}
                          >
                            <HelmxIcon name={copiedCmd ? 'check' : 'copy'} size={12} />
                            <span>{copiedCmd ? t('nodes.drawer.copied') : t('nodes.drawer.copyCommand')}</span>
                          </button>
                        </div>

                        <div className="text-subtle">
                          {t('nodes.drawer.maintenanceLabel')}
                        </div>
                        <div className="flex-row flex-row-wrap">
                          <code className="code-box selectable flex-1 mono">
                            {guide.startDaemonCommand}
                          </code>
                          <CopyButton text={guide.startDaemonCommand} />
                        </div>
                        <div className="flex-row flex-row-wrap">
                          <code className="code-box selectable flex-1 mono">
                            {guide.doctorCommand}
                          </code>
                          <CopyButton text={guide.doctorCommand} />
                        </div>
                      </div>
                    )}
                  </section>
                )}

                {/* 4. Registered tool capabilities */}
                {!isNew && (
                  <section className="section-flat">
                    <div className="section-flat-header">
                      <HelmxIcon name="wrench" size={13} />
                      <span className="section-flat-title">{t('nodes.drawer.toolsSection')}</span>
                    </div>

                    <div className="primary-card-pills">
                      {tools.map((tool) => (
                        <span
                          key={tool}
                          className="primary-card-pill mono"
                          title={t('nodes.drawer.toolTitle', { tool })}
                        >
                          <HelmxIcon name="terminal" size={11} />
                          <span>{tool}</span>
                        </span>
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}

    </DetailDrawer>
  )
}
