/**
 * 全屏视图宿主：所有 screen 一律经 PluginUiView 渲染（json / client 双轨，零插件 ID 特判）。
 * 主屏 / 分屏分别由 App 传入对应 target；本组件把 params / isSplit / setParams
 * 组装为协议标准 ScreenProps 经 slotProps 注入插件组件。
 */
import * as React from 'react'
import { useMemo, useState } from 'react'
import { HelmxIcon, ScreenHostContext, ScreenParamsContext, type ScreenHostState } from '@helmx/plugin-client'
import { resolveLocalizedText, type ScreenParamsScope, type ScreenSpec } from '@helmx/protocol/browser'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useGroupedUi, useLocationTargets, useStoreActions } from '../lib/store-context.js'
import type { ResolvedTarget } from '../lib/types.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import { usePaneSplitToggle } from '../ui/use-pane-split-toggle.js'

export interface ScreenHostProps {
  pluginId: string
  screenId: string
  isSplit?: boolean
  onCloseSplit?: () => void
}

export function ScreenHost({ pluginId, screenId, isSplit, onCloseSplit }: ScreenHostProps): React.JSX.Element {
  const groupedUi = useGroupedUi()
  // 顶栏 `.pane-actions` 内的动作槽与顶栏下方通栏工具栏槽：宿主只提供 DOM 落点，
  // 插件 `<Screen actions>` 与 `<Screen toolbar>` 经 ScreenHostContext portal 进来
  // （与五大中心共享同一套页面壳结构），无贡献的槽为空不占位。
  const [headerActionsSlot, setHeaderActionsSlot] = useState<HTMLDivElement | null>(null)
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null)
  const screenHostState = useMemo<ScreenHostState>(
    () => ({ hosted: true, headerActionsSlot, toolbarSlot }),
    [headerActionsSlot, toolbarSlot],
  )
  const { primaryTarget, splitTarget } = useLocationTargets()
  const { setScreenParams } = useStoreActions()
  const { locale, t } = useWebLocale()
  const matched = groupedUi.screens.find(
    (s) => s.pluginId === pluginId && (s.spec as { id?: string }).id === screenId,
  )

  // 参数取自当前屏（主/分屏各自独立），setParams 同样绑定到当前屏的 store 方法；
  // 单一派生同时供协议 ScreenProps（slotProps）与 useScreenParams 的
  // ScreenParamsContext（屏内嵌套组件免 prop-drilling），URL hash 仍是唯一真相。
  const target: ResolvedTarget | null = isSplit ? splitTarget : primaryTarget
  const screenScope = useMemo<ScreenParamsScope>(() => {
    const params =
      target !== null && target.kind === 'screen' && target.pluginId === pluginId && target.screenId === screenId
        ? target.params ?? {}
        : {}
    return {
      isSplit: isSplit === true,
      params,
      setParams: (patch: Record<string, string | undefined>, options?: { push?: boolean }) =>
        setScreenParams(patch, { split: isSplit === true, push: options?.push }),
    }
  }, [pluginId, screenId, isSplit, target, setScreenParams])
  const slotProps = useMemo<Record<string, unknown>>(
    () => ({ pluginId, screenId, ...screenScope }),
    [pluginId, screenId, screenScope],
  )

  const { isSplitActive, toggleSplit } = usePaneSplitToggle({
    isSplit,
    onCloseSplit,
    getSplitTarget: () => ({
      kind: 'screen',
      pluginId,
      screenId,
      params: target !== null && target.kind === 'screen' ? target.params : undefined,
    }),
  })

  if (matched === undefined) {
    return (
      <div className="helmx-pane screen-pane">
        <div className="pane-topbar">
          <div className="pane-title-group">
            <HelmxIcon name="alert-triangle" size={14} />
            <span className="pane-title">
              {t('shell.screen.notFoundTitle', { pluginId, screenId })}
            </span>
          </div>
          <div className="pane-actions">
            {isSplit ? (
              <CloseSplitButton onCloseSplit={onCloseSplit} />
            ) : (
              <SplitToggleButton
                isSplitActive={isSplitActive}
                onToggleSplit={toggleSplit}
              />
            )}
          </div>
        </div>
        <div className="screen-host-body" data-screen-host="true">
          <div className="callout callout-warn">
            <HelmxIcon name="alert-triangle" size={13} />
            <span>
              {t('shell.screen.notFoundBody', { pluginId, screenId })}
            </span>
          </div>
        </div>
      </div>
    )
  }

  // 视图标题（ScreenSpec.label）属 LocalizedText 显示元数据：按 store 权威 locale 解析。
  const spec = matched.spec as ScreenSpec

  return (
    <div className="helmx-pane screen-pane">
      <div className="pane-topbar">
        <div className="pane-title-group">
          {spec.icon !== undefined && <HelmxIcon name={spec.icon} size={14} />}
          <span className="pane-title">{resolveLocalizedText(spec.label, locale) || `${pluginId}/${screenId}`}</span>
        </div>
        <div className="pane-actions">
          <div ref={setHeaderActionsSlot} className="pane-actions-slot" />
          {isSplit ? (
            <CloseSplitButton onCloseSplit={onCloseSplit} />
          ) : (
            <SplitToggleButton
              isSplitActive={isSplitActive}
              onToggleSplit={toggleSplit}
            />
          )}
        </div>
      </div>
      <div ref={setToolbarSlot} className="screen-host-toolbar-slot" />
      <div className="screen-host-body" data-screen-host="true">
        <ScreenHostContext.Provider value={screenHostState}>
          <ScreenParamsContext.Provider value={screenScope}>
            <PluginUiView
              pluginId={pluginId}
              spec={spec}
              slotProps={slotProps}
              label={t('shell.screen.viewLabel', { id: screenId })}
            />
          </ScreenParamsContext.Provider>
        </ScreenHostContext.Provider>
      </div>
    </div>
  )
}
