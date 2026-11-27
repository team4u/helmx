import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ArtifactMetadata, ConversationSummary } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  EmptyState,
  HelmxIcon,
  List,
  ListRow,
  StatusLight,
  TabCount,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@helmx/plugin-client'
import {
  useConversationArtifacts,
  useConversationDetail,
  useConversationSummary,
  useLocationTargets,
  useSseConnected,
  useStoreActions,
  useWorkbenchState,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { artifactsApi } from '../lib/api.js'
import { formatBytes, formatFullTimestamp, formatMessageTime } from '../lib/format.js'
import {
  artifactFormatLabel,
  artifactIconName,
  artifactMimeRedundant,
  artifactKindLabel,
  buildWorkbenchFooter,
  isImageArtifact,
  partitionArtifactsByKind,
  resolveActiveWorkbenchTab,
  type WorkbenchTab,
} from './workbench-model.js'
import { useWorkbenchTabs } from './workbench-hooks.js'

function ArtifactThumb({ artifactId, filename }: { artifactId: string; filename: string }) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)

  useEffect(() => {
    if (
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function' ||
      typeof URL.revokeObjectURL !== 'function'
    ) {
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    void artifactsApi.fetchBlob(artifactId, true)
      .then((blob) => {
        if (cancelled || !blob || blob.size === 0) return
        objectUrl = URL.createObjectURL(blob)
        setThumbUrl(objectUrl)
      })
      .catch(() => {
        /* Keep the default icon placeholder when thumbnail loading fails */
      })
    return () => {
      cancelled = true
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [artifactId])

  if (thumbUrl !== null) {
    return <img src={thumbUrl} alt={filename} className="artifact-thumb-img" loading="lazy" />
  }
  return <HelmxIcon name="file" size={16} />
}

interface ArtifactCardProps {
  artifact: ArtifactMetadata
  compact?: boolean
  isDownloading: boolean
  onPreview: (artifact: ArtifactMetadata) => void
  onDownload: (artifact: ArtifactMetadata) => void
}

function ArtifactCard({
  artifact,
  compact = false,
  isDownloading,
  onPreview,
  onDownload,
}: ArtifactCardProps) {
  const { t } = useWebLocale()
  const formatLabel = artifactFormatLabel(artifact.mimeType, artifact.name, t)
  const timestamp = artifact.createdAt > 0 ? formatMessageTime(artifact.createdAt) : ''
  // Do not duplicate the raw MIME string once the display format is derived from it (full MIME remains visible in preview).
  const mimeRedundant = artifactMimeRedundant(artifact.mimeType, artifact.name)

  return (
    <ListRow
      data-artifact-id={artifact.id}
      data-artifact-kind={artifact.kind}
      onSelect={() => onPreview(artifact)}
      leading={
        <span className={compact ? 'artifact-thumb artifact-thumb-compact' : 'artifact-thumb'} aria-hidden="true">
          {!compact && isImageArtifact(artifact.mimeType) ? (
            <ArtifactThumb artifactId={artifact.id} filename={artifact.name} />
          ) : (
            <HelmxIcon name={artifactIconName(artifact.mimeType, artifact.kind)} size={compact ? 14 : 16} />
          )}
        </span>
      }
      title={artifact.name}
      meta={
        <>
          <Badge tone={artifact.kind === 'registered' ? 'accent' : 'neutral'}>
            {artifactKindLabel(artifact.kind, t)}
          </Badge>
          <span
            className="artifact-format"
            title={mimeRedundant ? artifact.mimeType : undefined}
          >
            {formatLabel}
          </span>
          {mimeRedundant ? null : (
            <span className="mono artifact-mime" title={artifact.mimeType}>{artifact.mimeType}</span>
          )}
          <span className="mono tabular-nums">{formatBytes(artifact.size)}</span>
          {timestamp !== '' ? (
            <span title={formatFullTimestamp(artifact.createdAt)}>
              {timestamp}
            </span>
          ) : null}
        </>
      }
      actions={
        <>
          <Button
            variant="ghost"
            size="xs"
            icon="eye"
            className="artifact-action-btn"
            aria-label={t('conv.attachment.previewName', { name: artifact.name })}
            title={t('conv.workbench.preview')}
            onClick={() => onPreview(artifact)}
          >
            <span>{t('conv.workbench.preview')}</span>
          </Button>
          <Button
            variant="ghost"
            size="xs"
            icon="download"
            pending={isDownloading}
            className="artifact-action-btn"
            aria-label={t('conv.workbench.downloadName', { name: artifact.name })}
            title={t('common.download')}
            onClick={() => onDownload(artifact)}
          >
            <span>{isDownloading ? t('conv.workbench.downloading') : t('common.download')}</span>
          </Button>
        </>
      }
    />
  )
}

function ArtifactsTab({ conversationId }: { conversationId: number }) {
  const rawArtifacts = useConversationArtifacts(conversationId)
  const { setActiveModal, pushNotice } = useStoreActions()
  const { t } = useWebLocale()
  const artifacts = useMemo(() => (Array.isArray(rawArtifacts) ? rawArtifacts : []), [rawArtifacts])
  const { deliverables, spills } = useMemo(() => partitionArtifactsByKind(artifacts), [artifacts])
  const [spillExpanded, setSpillExpanded] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const spillPanelId = useId()

  const handlePreview = (artifact: ArtifactMetadata) => {
    setActiveModal({ kind: 'artifact-preview', artifactId: artifact.id, conversationId })
  }

  const handleDownload = (artifact: ArtifactMetadata) => {
    setDownloadingId(artifact.id)
    void artifactsApi.downloadToBrowser(artifact.id, artifact.name)
      .catch((err) => {
        pushNotice({
          type: 'notification',
          level: 'error',
          title: t('conv.workbench.downloadFailed'),
          body: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => {
        setDownloadingId((current) => (current === artifact.id ? null : current))
      })
  }

  if (artifacts.length === 0) {
    return (
      <EmptyState compact title={t('conv.workbench.noArtifacts')} />
    )
  }

  return (
    <div className="workbench-artifacts-body">
      <section className="artifact-section" aria-label={t('conv.workbench.registeredSectionAria')}>
        <div className="artifact-section-head">
          <span className="artifact-section-title">{t('conv.workbench.deliverablesTitle')}</span>
          <Badge tone="neutral" className="tabular-nums">{deliverables.length}</Badge>
        </div>
        {deliverables.length === 0 ? (
          <EmptyState compact title={t('conv.workbench.noDeliverables')} />
        ) : (
          <List density="compact" label={t('conv.workbench.registeredSectionAria')}>
            {deliverables.map((artifact) => (
              <ArtifactCard
                key={artifact.id}
                artifact={artifact}
                isDownloading={downloadingId === artifact.id}
                onPreview={handlePreview}
                onDownload={handleDownload}
              />
            ))}
          </List>
        )}
      </section>

      {spills.length > 0 ? (
        <section className="artifact-spill-section" aria-label={t('conv.workbench.spillTitle')}>
          <button
            type="button"
            className="artifact-spill-toggle"
            aria-expanded={spillExpanded}
            aria-controls={spillPanelId}
            onClick={() => setSpillExpanded((v) => !v)}
          >
            <HelmxIcon name={spillExpanded ? 'chevron-down' : 'chevron-right'} size={13} />
            <span className="artifact-spill-title">{t('conv.workbench.spillTitle')}</span>
            <Badge tone="neutral" className="tabular-nums">{spills.length}</Badge>
            <span className="artifact-spill-hint">{spillExpanded ? t('common.collapse') : t('conv.workbench.clickToExpand')}</span>
          </button>
          {spillExpanded ? (
            <List
              id={spillPanelId}
              density="compact"
              className="artifact-spill-list"
              label={t('conv.workbench.spillTitle')}
            >
              {spills.map((artifact) => (
                <ArtifactCard
                  key={artifact.id}
                  artifact={artifact}
                  compact
                  isDownloading={downloadingId === artifact.id}
                  onPreview={handlePreview}
                  onDownload={handleDownload}
                />
              ))}
            </List>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

export interface WorkbenchViewProps {
  conversation?: ConversationSummary
  /** Conversation ID to scope the workbench (falls back to active primary/split conversation). */
  conversationId?: number
  /** Controlled tab value for this frame (defaults to store workbenchTab). */
  tab?: string
  /** Callback when the user switches tabs (defaults to store setWorkbenchTab). */
  onTabChange?: (tab: string) => void
  /** Only normalize unavailable tabs into the URL when this frame is the visible top frame. */
  active?: boolean
}

function WorkbenchPluginTabPane({
  tab,
  conversationId,
  conversation,
  params,
  isTabActive,
  label,
}: {
  tab: WorkbenchTab
  conversationId: number
  conversation: ConversationSummary | undefined
  params: Readonly<Record<string, unknown>> | undefined
  isTabActive: boolean
  label: string
}) {
  const slotProps = useMemo(() => {
    if (conversation === undefined && params === undefined) return undefined
    return {
      ...(conversation !== undefined ? { conversation } : {}),
      ...(params !== undefined ? { params } : {}),
    }
  }, [conversation, params])

  return (
    <div
      className="workbench-plugin-body"
      hidden={!isTabActive}
      style={isTabActive ? undefined : { display: 'none' }}
    >
      <PluginUiView
        pluginId={tab.pluginId!}
        spec={tab.spec!}
        conversationId={conversationId}
        label={label}
        slotProps={slotProps}
      />
    </div>
  )
}

/**
 * Embedded workbench surface rendered inside DrawerStackShell (and directly in
 * workbench unit tests): built-in Artifacts tab + plugin workbench.panel tabs.
 * Close / breadcrumb chrome belongs solely to DrawerStackShell.
 */
export function WorkbenchView(props: WorkbenchViewProps) {
  const { primaryTarget, splitTarget } = useLocationTargets()
  const sseConnected = useSseConnected()
  const { workbenchTab: storeWorkbenchTab, workbenchParams } = useWorkbenchState()
  const { setWorkbenchTab } = useStoreActions()
  const { t } = useWebLocale()
  const active = props.active ?? true
  const currentTab = props.tab ?? storeWorkbenchTab
  const handleTabChange = props.onTabChange ?? setWorkbenchTab

  const conversationId =
    props.conversation?.id ??
    props.conversationId ??
    (primaryTarget.kind === 'conversation'
      ? primaryTarget.conversationId
      : splitTarget?.kind === 'conversation'
        ? splitTarget.conversationId
        : undefined)
  const summary = useConversationSummary(props.conversation === undefined ? conversationId : undefined)
  const detail = useConversationDetail(props.conversation === undefined ? conversationId : undefined)
  const conversation = props.conversation ?? summary ?? detail
  const tabs = useWorkbenchTabs(conversationId, conversation)
  const activeTab = resolveActiveWorkbenchTab(currentTab, tabs)
  const activePanel = tabs.find((tab) => tab.id === activeTab && tab.pluginId !== undefined)
  const footerParts = buildWorkbenchFooter(tabs)

  // Keep visited plugin workbench tabs mounted per conversation so switching
  // tabs preserves plugin local state & scroll; reset on conversation switch.
  const [visitedState, setVisitedState] = useState<{ conversationId: number | undefined; tabIds: string[] }>(() => ({
    conversationId,
    tabIds: activePanel !== undefined ? [activePanel.id] : [],
  }))
  const visitedTabIds = useMemo(() => {
    const base = visitedState.conversationId === conversationId ? visitedState.tabIds : []
    if (activePanel !== undefined && !base.includes(activePanel.id)) {
      return [...base, activePanel.id]
    }
    return base
  }, [visitedState, conversationId, activePanel])

  useEffect(() => {
    setVisitedState((prev) => {
      if (prev.conversationId !== conversationId) {
        return { conversationId, tabIds: activePanel !== undefined ? [activePanel.id] : [] }
      }
      if (activePanel !== undefined && !prev.tabIds.includes(activePanel.id)) {
        return { conversationId, tabIds: [...prev.tabIds, activePanel.id] }
      }
      return prev
    })
  }, [conversationId, activePanel])

  const mountedPluginTabs = useMemo(
    () =>
      tabs.filter(
        (tab) =>
          tab.pluginId !== undefined &&
          tab.spec !== undefined &&
          visitedTabIds.includes(tab.id),
      ),
    [tabs, visitedTabIds],
  )

  useEffect(() => {
    // Preserve deep links until SSE UI contributions and conversation arrive;
    // normalize unavailable tabs only while this workbench frame is active on top.
    if (active && sseConnected && conversation !== undefined && activeTab !== currentTab) {
      handleTabChange(activeTab)
    }
  }, [active, sseConnected, conversation, activeTab, currentTab, handleTabChange])

  const tabsScrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const activeEl = tabsScrollRef.current?.querySelector('.tab-btn-active') as HTMLElement | null
    activeEl?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeTab, tabs.length])

  return (
    <div className="helmx-workbench-view">
      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        variant="underline"
        size="sm"
        className="workbench-tabs-root"
      >
        <TabsList ref={tabsScrollRef} scrollable className="workbench-tabs-scroll">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              <span>{tab.label}</span>
              {tab.count > 0 ? <TabCount>{tab.count}</TabCount> : null}
              {tab.count > 0 && tab.tone !== 'neutral' ? (
                <StatusLight
                  tone={tab.tone === 'warn' ? 'blocked' : 'working'}
                  aria-label={tab.label}
                  className="workbench-tab-status"
                />
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="workbench-body">
          {conversationId === undefined ? (
            <EmptyState compact title={t('conv.workbench.noActiveConversation')} />
          ) : (
            <>
              {activeTab === 'artifacts' ? (
                <ArtifactsTab key={conversationId} conversationId={conversationId} />
              ) : activePanel === undefined ? (
                <EmptyState compact title={t('conv.workbench.tabUnavailable')} />
              ) : null}
              {mountedPluginTabs.map((tab) => {
                const isTabActive = tab.id === activeTab
                const tabParams =
                  workbenchParams !== null &&
                  workbenchParams.tab === tab.id &&
                  (workbenchParams.conversationId === undefined || workbenchParams.conversationId === conversationId)
                    ? workbenchParams.params
                    : undefined
                return (
                  <WorkbenchPluginTabPane
                    key={`${conversationId}:${tab.id}`}
                    tab={tab}
                    conversationId={conversationId}
                    conversation={conversation}
                    params={tabParams}
                    isTabActive={isTabActive}
                    label={t('conv.workbench.panelLabel', { label: tab.label })}
                  />
                )
              })}
            </>
          )}
        </div>
      </Tabs>
      {footerParts.length > 0 ? (
        <div className="workbench-footer">
          {footerParts.map((part) => (
            <Badge key={part} tone="neutral">{part}</Badge>
          ))}
        </div>
      ) : null}
    </div>
  )
}
