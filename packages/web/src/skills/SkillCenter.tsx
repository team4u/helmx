import type * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Button, Callout, CardGrid, EmptyState, HelmxIcon, Select, Stack, type SelectOption } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useLocationTargets, useNodes, useSkills, useStoreActions } from '../lib/store-context.js'
import type { ResolvedTarget } from '../lib/types.js'
import { SystemCenterShell, SystemCenterToolbar } from '../ui/SystemCenterShell.js'
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
  const { openTarget, refreshAssets, invokePluginAction } = useStoreActions()
  const { t } = useWebLocale()
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState<SkillCategoryTab>('all')
  const [reloadSeq, setReloadSeq] = useState(0)

  const currentTarget = isSplit ? splitTarget : primaryTarget
  const rawNodeId = currentTarget !== null && currentTarget.kind === 'skills' ? currentTarget.nodeId : undefined
  const { nodeId, shouldNormalize } = useMemo(() => parseSkillCenterNodeId(rawNodeId), [rawNodeId])
  const scope = useMemo(() => (nodeId === undefined ? undefined : { nodeId }), [nodeId])

  const scopedCatalog = useScopedSkillCatalog(scope, invokePluginAction, reloadSeq)

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
        return readScopedSkillFile(invokePluginAction, scope, skillId, path)
      }
      return skillsApi.read(skillId, path)
    }
  }, [scope, skills, invokePluginAction])

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

  return (
    <SystemCenterShell
      dataView="skill-center"
      className="skill-center"
      isSplit={isSplit}
      isSplitActive={isSplitActive}
      onCloseSplit={onCloseSplit}
      onToggleSplit={toggleSplit}
      icon="sparkles"
      title={t('skills.center.title')}
      headerActions={
        <Button
          size="sm"
          icon="refresh-cw"
          onClick={handleRefresh}
          title={scope === undefined ? t('skills.center.refreshTitle') : t('skills.scope.reloadTitle')}
        >
          <span className="pane-action-label">{t('common.refresh')}</span>
        </Button>
      }
      toolbar={
        <SystemCenterToolbar
          leading={
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
          }
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder={t('skills.center.searchPlaceholder')}
          searchAriaLabel={t('skills.center.searchLabel')}
          clearSearchLabel={t('skills.center.clearSearch')}
          filterAriaLabel={t('skills.center.filterLabel')}
          pills={pills}
          activePill={activeTab}
          onSelectPill={setActiveTab}
        />
      }
      diagnostics={
        scope !== undefined ? (
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
              <div className="skill-scope-loading text-subtle" role="status">
                <HelmxIcon name="loader" size={12} className="spin" />
                <span>{t('skills.scope.loading')}</span>
              </div>
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
    </SystemCenterShell>
  )
}
