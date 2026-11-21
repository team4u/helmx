import React, { useEffect, useMemo, useState } from 'react'
import { HelmxIcon, SearchBox, Select } from '@helmx/plugin-client'
import type { SelectOption } from '@helmx/plugin-client'
import {
  useLocationTargets,
  useNodes,
  useSkills,
  useStoreActions,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
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

const CATEGORY_TABS: SkillCategoryTab[] = ['all', 'builtin', 'plugins', 'agents', 'node', 'workspace']

/**
 * Full-screen skill center (primary stage) container:
 * - a system-level full-screen view managing model tool skills, playbooks and
 *   code reference guides;
 * - node selector: Hub ('local') by default, or any usable online compute
 *   node (from useNodes(), never conversations/cwds); switching nodes rides
 *   the skills target's `node` query param (top-level for the primary, inside
 *   the split value for the split pane) and pushes to browser history so
 *   deep links, refresh and back/forward all restore it, while detail
 *   open/close preserves the selected node;
 * - top bar: title, split actions and the refresh action (node reload vs
 *   Hub asset refresh);
 * - search bar: fuzzy search across ID / name / description / reference file
 *   paths, combined with category pill tabs (node-sourced skills form their
 *   own category; node offline / same-name shadowing report as explicit
 *   callouts, never silently degrading);
 * - responsive card grid: SkillCard cells, zero emoji;
 * - detail & doc reader drawer: SkillDetailDrawer showing SKILL.md and
 *   references/*.md (node-sourced skills read through the builtin:profile
 *   action for the selected node);
 * - follows the zero-emoji rule and Fast Refresh conventions strictly.
 */
export function SkillCenter({
  isSplit = false,
  onCloseSplit,
  inlineDrawer = false,
}: SkillCenterProps): React.JSX.Element {
  const hubSkills = useSkills() ?? []
  const nodes = useNodes()
  const { primaryTarget, splitTarget } = useLocationTargets()
  const { openTarget, closeSplit, refreshAssets, invokePluginAction } = useStoreActions()
  const { t } = useWebLocale()
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState<SkillCategoryTab>('all')
  const [reloadSeq, setReloadSeq] = useState(0)

  const currentTarget = isSplit ? splitTarget : primaryTarget
  const rawNodeId = currentTarget !== null && currentTarget.kind === 'skills' ? currentTarget.nodeId : undefined
  // Hub default when unset or 'local'; non-canonical ?node=local / whitespace self-heals via replace.
  const { nodeId, shouldNormalize } = useMemo(() => parseSkillCenterNodeId(rawNodeId), [rawNodeId])
  const scope = useMemo(() => (nodeId === undefined ? undefined : { nodeId }), [nodeId])

  const scopedCatalog = useScopedSkillCatalog(scope, invokePluginAction, reloadSeq)

  // Hub consumes the store's /api/skills list; a selected remote node consumes
  // the merged action catalog (empty while loading — never a phantom Hub list).
  const skills = useMemo(
    () => (scope === undefined ? hubSkills : scopedCatalog.catalog?.skills ?? []),
    [scope, hubSkills, scopedCatalog.catalog],
  )

  const categoryCounts = useMemo(() => buildSkillCategoryCounts(skills), [skills])

  const filteredSkills = useMemo(() => {
    return filterSkills(skills, {
      query,
      categoryTab: activeTab,
    })
  }, [skills, query, activeTab])

  const selectedSkillId =
    currentTarget && currentTarget.kind === 'skills' ? currentTarget.skillId : undefined

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

  // Detail open/close keeps the selected node.
  const handleSelectSkill = (skillId: string) => {
    openTarget(
      skillCenterTarget(nodeId, { skillId }),
      isSplit ? { split: true } : undefined,
    )
  }

  const handleCloseDrawer = () => {
    openTarget(skillCenterTarget(nodeId), isSplit ? { split: true } : undefined)
  }

  const toggleSplit = () => {
    if (isSplit) {
      onCloseSplit?.()
      return
    }
    if (splitTarget !== null) {
      closeSplit()
      return
    }
    openTarget(skillCenterTarget(nodeId, { skillId: selectedSkillId }), { split: true })
  }

  const scopeOptions: Array<SelectOption<string>> = useMemo(
    () => buildSkillNodeOptions(nodes, nodeId, t),
    [nodes, nodeId, t],
  )

  const handleScopeChange = (nextValue: string) => {
    const nextNodeId = nextValue === HUB_SKILL_NODE_ID ? undefined : nextValue
    // Node switch pushes to browser history (per shouldPushLocationHistory) and drops any stale detail selection.
    openTarget(skillCenterTarget(nextNodeId), isSplit ? { split: true } : undefined)
  }

  const handleRefresh = () => {
    if (scope !== undefined) {
      setReloadSeq((seq) => seq + 1)
      return
    }
    void refreshAssets?.()
  }

  // Node-sourced skill files read through the builtin:profile action for the
  // selected node; Hub-sourced files keep the direct asset read.
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
    <div className={`primary-center skill-center${isSplit ? ' is-split' : ''}`} data-view="skill-center">
      {/* Top bar: title and actions */}
      <div className="primary-center-topbar pane-topbar">
        <div className="primary-center-title-wrap pane-title-group">
          <div className="primary-center-title">
            <HelmxIcon name="sparkles" size={14} />
            <span>{t('skills.center.title')}</span>
          </div>
        </div>

        <div className="primary-center-topbar-actions pane-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleRefresh}
            title={scope === undefined ? t('skills.center.refreshTitle') : t('skills.scope.reloadTitle')}
          >
            <HelmxIcon name="refresh-cw" size={12} />
            <span className="pane-action-label">{t('common.refresh')}</span>
          </button>
          {isSplit ? (
            <CloseSplitButton onCloseSplit={onCloseSplit} />
          ) : (
            <SplitToggleButton
              isSplitActive={splitTarget !== null}
              onToggleSplit={toggleSplit}
            />
          )}
        </div>
      </div>

      {/* Search bar, node selector and category filter pills */}
      <div className="primary-center-toolbar">
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

        <SearchBox
          className="primary-search-box"
          clearButtonClassName="btn btn-ghost btn-sm primary-search-clear"
          value={query}
          onChange={setQuery}
          placeholder={t('skills.center.searchPlaceholder')}
          ariaLabel={t('skills.center.searchLabel')}
          clearLabel={t('skills.center.clearSearch')}
        />

        <div className="primary-category-pills" role="tablist" aria-label={t('skills.center.filterLabel')}>
          {CATEGORY_TABS.map((tabKey) => {
            const count = categoryCounts[tabKey] ?? 0
            const isActive = activeTab === tabKey
            return (
              <button
                key={tabKey}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`primary-category-pill${isActive ? ' is-active' : ''}`}
                onClick={() => setActiveTab(tabKey)}
              >
                <span>{skillCategoryTabLabel(tabKey, t)}</span>
                <span className="badge tabular-nums">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Node diagnostics: explicit load error / node-unavailable / offline / shadowing */}
      {scope !== undefined && (
        <div className="skill-scope-diagnostics">
          {scopeLoadError !== null && (
            <div className="callout callout-error" role="alert">
              <HelmxIcon name="alert-circle" size={13} />
              <span className="callout-text">{t('skills.scope.loadFailed', { error: scopeLoadError })}</span>
              <button type="button" className="btn btn-sm" onClick={() => setReloadSeq((seq) => seq + 1)}>
                <HelmxIcon name="rotate-ccw" size={12} />
                <span>{t('skills.scope.retry')}</span>
              </button>
            </div>
          )}
          {scopeLoadError === null && nodeUnavailable !== undefined && (
            <div className="callout callout-warn" role="alert">
              <HelmxIcon name="alert-triangle" size={13} />
              <span className="callout-text">{t('skills.scope.nodeUnavailable', { reason: nodeUnavailable })}</span>
            </div>
          )}
          {disconnectedNotice && (
            <div className="callout callout-warn" role="alert">
              <HelmxIcon name="alert-triangle" size={13} />
              <span className="callout-text">
                {t('skills.scope.nodeOfflineWarning', { node: selectedNodeRecord.id })}
              </span>
            </div>
          )}
          {scopeLoadError === null && shadowedNodeSkillIds.length > 0 && (
            <div className="callout" role="status">
              <HelmxIcon name="layers" size={13} />
              <span className="callout-text">
                {t('skills.scope.shadowed', { ids: shadowedNodeSkillIds.join(', ') })}
              </span>
            </div>
          )}
          {scopeLoading && scopeLoadError === null && (
            <div className="skill-scope-loading text-subtle" role="status">
              <HelmxIcon name="loader" size={12} className="spin" />
              <span>{t('skills.scope.loading')}</span>
            </div>
          )}
        </div>
      )}

      {/* Main viewport: responsive card grid or empty state */}
      <div className="primary-center-content">
        {filteredSkills.length > 0 ? (
          <div className="primary-center-grid">
            {filteredSkills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                selected={selectedSkillId === skill.id}
                onSelect={() => handleSelectSkill(skill.id)}
              />
            ))}
          </div>
        ) : (
          <div className="primary-center-empty">
            <div className="primary-center-empty-icon">
              <HelmxIcon name="search" size={28} />
            </div>
            <div className="primary-center-empty-text">{t('skills.center.emptyTitle')}</div>
            <div className="primary-center-empty-hint">{t('skills.center.emptyHint')}</div>
            {(query || activeTab !== 'all') && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setQuery('')
                  setActiveTab('all')
                }}
              >
                <HelmxIcon name="rotate-ccw" size={12} />
                <span>{t('skills.center.resetFilters')}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Right slide-over details and documentation reader drawer */}
      <SkillDetailDrawer
        skill={selectedSkill}
        open={isDrawerOpen}
        onClose={handleCloseDrawer}
        inline={inlineDrawer}
        readSkill={drawerReader}
        nodeScope={scope}
      />
    </div>
  )
}
