import type * as React from 'react'
import { useId, useMemo, useState } from 'react'
import {
  Button,
  CardGrid,
  EmptyState,
  Screen,
  ScreenToolbar,
  SearchBox,
  TabCount,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@helmx/ui'
import type { WebMessageKey } from '../i18n/catalog.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useLocationTargets, useNodes, useStoreActions } from '../lib/store-context.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import { usePaneSplitToggle } from '../ui/use-pane-split-toggle.js'
import { NodeCard } from './NodeCard.js'
import { NodeDetailDrawer } from './NodeDetailDrawer.js'
import {
  buildNodeCategoryCounts,
  filterNodes,
  type NodeCategoryTab,
  type NodeInfo,
} from './node-center-model.js'

export interface NodeCenterProps {
  isSplit?: boolean
  onCloseSplit?: () => void
  /** Render the detail drawer inline (uniform assertions for tests and SSR). */
  inlineDrawer?: boolean
}

const CATEGORY_TABS: ReadonlyArray<{ key: NodeCategoryTab; labelKey: WebMessageKey }> = [
  { key: 'all', labelKey: 'common.all' },
  { key: 'local', labelKey: 'nodes.local' },
  { key: 'remote', labelKey: 'nodes.remote' },
  { key: 'online', labelKey: 'common.online' },
  { key: 'offline', labelKey: 'common.offline' },
]

/**
 * Full-screen Compute Nodes Center primary view container.
 */
export function NodeCenter({
  isSplit = false,
  onCloseSplit,
  inlineDrawer = false,
}: NodeCenterProps): React.JSX.Element {
  const nodes = (useNodes() as NodeInfo[]) ?? []
  const { primaryTarget, splitTarget } = useLocationTargets()
  const { openTarget, refreshNodes } = useStoreActions()
  const { t } = useWebLocale()
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState<NodeCategoryTab>('all')
  const panelId = useId()

  const categoryCounts = useMemo(() => buildNodeCategoryCounts(nodes), [nodes])
  const pills = useMemo(
    () =>
      CATEGORY_TABS.map((tab) => ({
        key: tab.key,
        label: t(tab.labelKey),
        count: categoryCounts[tab.key] ?? 0,
      })),
    [categoryCounts, t],
  )

  const filteredNodes = useMemo(
    () => filterNodes(nodes, { query, categoryTab: activeTab }),
    [nodes, query, activeTab],
  )

  const currentTarget = isSplit ? splitTarget : primaryTarget
  const selectedNodeId = currentTarget?.kind === 'nodes' ? currentTarget.nodeId : undefined
  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  )
  const isAddingNew = selectedNodeId === 'new' && selectedNode === null
  const isDrawerOpen = isAddingNew || Boolean(selectedNodeId && selectedNode)

  const handleSelectNode = (nodeId: string) => {
    openTarget({ kind: 'nodes', nodeId }, isSplit ? { split: true } : undefined)
  }

  const handleConnectNew = () => {
    openTarget({ kind: 'nodes', nodeId: 'new' }, isSplit ? { split: true } : undefined)
  }

  const handleCloseDrawer = () => {
    openTarget({ kind: 'nodes' }, isSplit ? { split: true } : undefined)
  }

  const { isSplitActive, toggleSplit } = usePaneSplitToggle({
    isSplit,
    onCloseSplit,
    getSplitTarget: () => ({ kind: 'nodes', nodeId: selectedNodeId }),
  })

  return (
    <Screen
      topbar
      dataView="node-center"
      className={isSplit ? 'node-center is-split' : 'node-center'}
      icon="cpu"
      title={t('nodes.title')}
      bodyId={panelId}
      bodyRole="tabpanel"
      actions={
        <Button
          variant="primary"
          size="sm"
          icon="plus"
          onClick={handleConnectNew}
          title={t('nodes.connectTitle')}
        >
          <span className="pane-action-label">{t('nodes.connect')}</span>
        </Button>
      }
      topbarEnd={
        isSplit ? (
          <CloseSplitButton onCloseSplit={onCloseSplit} />
        ) : (
          <SplitToggleButton isSplitActive={isSplitActive} onToggleSplit={toggleSplit} />
        )
      }
      toolbar={
        <ScreenToolbar
          label={t('nodes.filterAria')}
          actions={
            <SearchBox
              variant="toolbar"
              size="sm"
              value={query}
              onChange={setQuery}
              placeholder={t('nodes.searchPlaceholder')}
              ariaLabel={t('nodes.searchAria')}
              clearLabel={t('nodes.searchClear')}
            />
          }
        >
          <Tabs
            value={activeTab}
            onValueChange={(nextValue) => setActiveTab(nextValue as NodeCategoryTab)}
            variant="pills"
            size="sm"
          >
            <TabsList aria-label={t('nodes.filterAria')}>
              {pills.map((pill) => (
                <TabsTrigger key={pill.key} value={pill.key} aria-controls={panelId}>
                  <span>{pill.label}</span>
                  <TabCount>{pill.count}</TabCount>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </ScreenToolbar>
      }
      overlays={
        <NodeDetailDrawer
          node={isAddingNew ? null : selectedNode}
          open={isDrawerOpen}
          isNew={isAddingNew}
          onClose={handleCloseDrawer}
          onRefresh={refreshNodes}
          inline={inlineDrawer}
        />
      }
    >
      {filteredNodes.length > 0 ? (
        <CardGrid minWidth="md" gap="md">
          {filteredNodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              selected={selectedNodeId === node.id}
              onSelect={() => handleSelectNode(node.id)}
            />
          ))}
        </CardGrid>
      ) : (
        <EmptyState
          prominent
          icon="search"
          title={t('nodes.emptyTitle')}
          hint={t('nodes.emptyHint')}
          hintSubtle
          action={
            Boolean(query) || activeTab !== 'all' ? (
              <Button
                size="sm"
                icon="rotate-ccw"
                onClick={() => {
                  setQuery('')
                  setActiveTab('all')
                }}
              >
                {t('nodes.resetFilters')}
              </Button>
            ) : undefined
          }
        />
      )}
    </Screen>
  )
}
