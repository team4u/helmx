import type * as React from 'react'
import { useEffect, useId, useMemo, useState } from 'react'
import {
  Button,
  Callout,
  CardGrid,
  EmptyState,
  LoadingState,
  Screen,
  ScreenToolbar,
  SearchBox,
  Select,
  Stack,
  TabCount,
  Tabs,
  TabsList,
  TabsTrigger,
  type SelectOption,
} from '@helmx/ui'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useLocationTargets, useNodes, useSkills, useStoreActions } from '../lib/store-context.js'
import type { ResolvedTarget } from '../lib/types.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import { usePaneSplitToggle } from '../ui/use-pane-split-toggle.js'
import { SkillCard } from './SkillCard.js'
import { SkillDetailDrawer } from './SkillDetailDrawer.js'
import {
  buildSkillCategoryCounts,
  filterSkills,
  skillCategoryTabLabel,
  skillsApi,
  type SkillCategoryTab,
} from './skill-center-model.js'
import { readScopedSkillFile } from './skill-scope-api.js'
import {
  HUB_SKILL_NODE_ID,
  buildSkillNodeOptions,
  isNodeSourceSkill,
  parseSkillCenterNodeId,
  skillCenterTarget,
} from './skill-scope-model.js'
import { useScopedSkillCatalog } from './use-scoped-skills.js'

export interface SkillCenterProps {
  isSplit?: boolean
  onCloseSplit?: () => void
  /** Render the detail drawer inline explicitly (for tests and unified SSR assertions). */
  inlineDrawer?: boolean
}

const CATEGORY_TABS: SkillCategoryTab[] = ['all', 'core', 'builtin', 'plugins', 'agents', 'node', 'workspace']

/**
 * Full-screen skill center (primary stage) container.
 */
export function SkillCenter({
  isSplit = false,
  onCloseSplit,
  inlineDrawer = false,
}: SkillCenterProps): React.JSX.Element {
  const hubSkills = useSkills() ?? []
  const nodes = useNodes()
  const { primaryTarget, splitTarget } = useLocationTargets()
  const { openTarget, refreshAssets } = useStoreActions()
  const { t } = useWebLocale()
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState<SkillCategoryTab>('all')
  const [reloadSeq, setReloadSeq] = useState(0)
  const panelId = useId()

  const currentTarget = isSplit ? splitTarget : primaryTarget
  const rawNodeId = currentTarget !== null && currentTarget.kind === 'skills' ? currentTarget.nodeId : undefined
  const { nodeId, shouldNormalize } = useMemo(() => parseSkillCenterNodeId(rawNodeId), [rawNodeId])
  const scope = useMemo(() => (nodeId === undefined ? undefined : { nodeId }), [nodeId])

  const scopedCatalog = useScopedSkillCatalog(scope, t, reloadSeq)

  const skills = useMemo(
    () => (scope === undefined ? hubSkills : scopedCatalog.catalog?.skills ?? []),
    [scope, hubSkills, scopedCatalog.catalog],
  )

  const categoryCounts = useMemo(() => buildSkillCategoryCounts(skills), [skills])
  const pills = useMemo(
    () =>
      CATEGORY_TABS.map((tabKey) => ({
        key: tabKey,
        label: skillCategoryTabLabel(tabKey, t),
        count: categoryCounts[tabKey] ?? 0,
      })),
    [categoryCounts, t],
  )

  const filteredSkills = useMemo(
    () => filterSkills(skills, { query, categoryTab: activeTab }),
    [skills, query, activeTab],
  )

  const selectedSkillId = currentTarget && currentTarget.kind === 'skills' ? currentTarget.skillId : undefined
  const selectedSkill = useMemo(
    () => skills.find((s) => s.id === selectedSkillId) ?? null,
    [skills, selectedSkillId],
  )
  const isDrawerOpen = Boolean(selectedSkillId && selectedSkill)

  useEffect(() => {
    if (!shouldNormalize) return
    openTarget(skillCenterTarget(nodeId, { skillId: selectedSkillId }), {
      ...(isSplit ? { split: true } : {}),
      history: 'replace',
    })
  }, [shouldNormalize, nodeId, isSplit, openTarget, selectedSkillId])

  const handleSelectSkill = (skillId: string) => {
    openTarget(skillCenterTarget(nodeId, { skillId }), isSplit ? { split: true } : undefined)
  }

  const handleCloseDrawer = () => {
    openTarget(skillCenterTarget(nodeId), isSplit ? { split: true } : undefined)
  }

  const handleOpenOwner = (target: Extract<ResolvedTarget, { kind: 'plugins' }>) => {
    openTarget(target, isSplit ? { split: true } : undefined)
  }

  const { isSplitActive, toggleSplit } = usePaneSplitToggle({
    isSplit,
    onCloseSplit,
    getSplitTarget: () => skillCenterTarget(nodeId, { skillId: selectedSkillId }),
  })

  const scopeOptions: Array<SelectOption<string>> = useMemo(
    () => buildSkillNodeOptions(nodes, nodeId, t),
    [nodes, nodeId, t],
  )

  const handleScopeChange = (nextValue: string) => {
    const nextNodeId = nextValue === HUB_SKILL_NODE_ID ? undefined : nextValue
    openTarget(skillCenterTarget(nextNodeId), isSplit ? { split: true } : undefined)
  }

  const handleRefresh = () => {
    if (scope !== undefined) {
      setReloadSeq((seq) => seq + 1)
      return
    }
    void refreshAssets?.()
  }

  const drawerReader = useMemo(() => {
    if (scope === undefined) return undefined
    return (skillId: string, path?: string) => {
      const summary = skills.find((s) => s.id === skillId)
      if (summary !== undefined && isNodeSourceSkill(summary)) {
        return readScopedSkillFile(scope, skillId, path, t)
      }
      return skillsApi.read(skillId, path)
    }
  }, [scope, skills, t])

  const selectedNodeRecord = useMemo(
    () => (nodeId === undefined ? undefined : nodes.find((n) => n.id === nodeId)),
    [nodes, nodeId],
  )
  const shadowedNodeSkillIds = scopedCatalog.catalog?.shadowedNodeSkillIds ?? []
  const nodeUnavailable = scopedCatalog.catalog?.nodeUnavailable
  const scopeLoadError = scopedCatalog.error
  const scopeLoading = scope !== undefined && scopedCatalog.loading
  const disconnectedNotice =
    scope !== undefined &&
    scopeLoadError === null &&
    nodeUnavailable === undefined &&
    selectedNodeRecord !== undefined &&
    !selectedNodeRecord.online

  const hasDiagnostics =
    scope !== undefined &&
    (scopeLoadError !== null ||
      nodeUnavailable !== undefined ||
      disconnectedNotice ||
      shadowedNodeSkillIds.length > 0 ||
      scopeLoading)

  return (
    <Screen
      topbar
      dataView="skill-center"
      className={isSplit ? 'skill-center is-split' : 'skill-center'}
      icon="sparkles"
      title={t('skills.center.title')}
      bodyId={panelId}
      bodyRole="tabpanel"
      actions={
        <Button
          variant="secondary"
          size="sm"
          icon="refresh-cw"
          onClick={handleRefresh}
          title={scope === undefined ? t('skills.center.refreshTitle') : t('skills.scope.reloadTitle')}
        >
          <span className="pane-action-label">{t('common.refresh')}</span>
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
          label={t('skills.center.filterLabel')}
          actions={
            <SearchBox
              variant="toolbar"
              size="sm"
              value={query}
              onChange={setQuery}
              placeholder={t('skills.center.searchPlaceholder')}
              ariaLabel={t('skills.center.searchLabel')}
              clearLabel={t('skills.center.clearSearch')}
            />
          }
        >
          <div className="skill-scope-picker">
            <Select
              className="skill-scope-select"
              size="sm"
              inline={inlineDrawer}
              value={nodeId ?? HUB_SKILL_NODE_ID}
              options={scopeOptions}
              onChange={(ev) => handleScopeChange(ev.target.value)}
              aria-label={t('skills.scope.label')}
              prefixIcon="server"
            />
          </div>
          <Tabs
            value={activeTab}
            onValueChange={(nextValue) => setActiveTab(nextValue as SkillCategoryTab)}
            variant="pills"
            size="sm"
          >
            <TabsList aria-label={t('skills.center.filterLabel')}>
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
      banner={
        hasDiagnostics ? (
          <div className="skill-scope-diagnostics">
            {scopeLoadError !== null && (
              <Callout tone="err">
                <Stack direction="horizontal" gap="sm" align="center" wrap>
                  <span className="callout-text" role="alert">
                    {t('skills.scope.loadFailed', { error: scopeLoadError })}
                  </span>
                  <Button size="sm" icon="rotate-ccw" onClick={() => setReloadSeq((seq) => seq + 1)}>
                    {t('skills.scope.retry')}
                  </Button>
                </Stack>
              </Callout>
            )}
            {scopeLoadError === null && nodeUnavailable !== undefined && (
              <Callout tone="warn">
                <span className="callout-text" role="alert">
                  {t('skills.scope.nodeUnavailable', { reason: nodeUnavailable })}
                </span>
              </Callout>
            )}
            {disconnectedNotice && (
              <Callout tone="warn">
                <span className="callout-text" role="alert">
                  {t('skills.scope.nodeOfflineWarning', { node: selectedNodeRecord.id })}
                </span>
              </Callout>
            )}
            {scopeLoadError === null && shadowedNodeSkillIds.length > 0 && (
              <Callout tone="info">
                <span className="callout-text" role="status">
                  {t('skills.scope.shadowed', { ids: shadowedNodeSkillIds.join(', ') })}
                </span>
              </Callout>
            )}
            {scopeLoading && scopeLoadError === null && (
              <LoadingState className="skill-scope-loading" label={t('skills.scope.loading')} />
            )}
          </div>
        ) : undefined
      }
      overlays={
        <SkillDetailDrawer
          skill={selectedSkill}
          open={isDrawerOpen}
          onClose={handleCloseDrawer}
          isSplit={isSplit}
          onOpenOwner={handleOpenOwner}
          inline={inlineDrawer}
          readSkill={drawerReader}
          nodeScope={scope}
        />
      }
    >
      {filteredSkills.length > 0 ? (
        <CardGrid minWidth="md" gap="md">
          {filteredSkills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              selected={selectedSkillId === skill.id}
              onSelect={() => handleSelectSkill(skill.id)}
            />
          ))}
        </CardGrid>
      ) : (
        <EmptyState
          prominent
          icon="search"
          title={t('skills.center.emptyTitle')}
          hint={t('skills.center.emptyHint')}
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
                {t('skills.center.resetFilters')}
              </Button>
            ) : undefined
          }
        />
      )}
    </Screen>
  )
}
