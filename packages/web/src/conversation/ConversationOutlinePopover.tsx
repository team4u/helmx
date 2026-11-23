import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HelmxIcon, Popover, PopoverContent, PopoverTrigger, useSharedNowMs } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  formatDurationMs,
  formatMessageTime,
  formatStopwatchMs,
  resolveConversationTiming,
  type ConversationTimingInput,
} from '../lib/format.js'
import {
  countOutlineTurns,
  filterOutlineNodes,
  type OutlineAnchor,
  type OutlineFilterMode,
  type OutlineNode,
} from './outline-model.js'

/** 大纲节点跳转目标：时间线包装 entryId + 回合内二级锚（headingIndex / cardId）+ 节点 key。 */
export interface OutlineJumpTarget extends OutlineAnchor {
  nodeKey?: string
}

export interface ConversationOutlinePopoverProps {
  nodes: ReadonlyArray<OutlineNode>
  /**
   * 当前阅读位置对应的大纲节点唯一 key（唯一激活通路，任何时刻至多一个 `is-current`）：
   * 会话大纲由 `resolveOutlineNodeKey` 从阅读锚点推导（同一助手回合内精确到当前读到的标题节），
   * 文档大纲用 `outline:markdown:<index>` 区分同一 entryId 下的不同标题。
   */
  activeNodeKey?: string
  /** 触发按钮文案，默认「大纲」。 */
  triggerLabel?: string
  /** 触发按钮标题，默认显示会话轮数。 */
  triggerTitle?: string
  /** 触发按钮角标数量，未传时使用人类提问轮数。 */
  badgeCount?: number
  /** 搜索框占位文案。 */
  searchPlaceholder?: string
  /** 浮层与搜索框的无障碍名称。 */
  accessibilityLabel?: string
  /** 是否显示「对话 / 仅提问 / 全部」切换，文档大纲不需要该切换。 */
  showModeToggle?: boolean
  /** 是否通过 Portal 渲染浮层；Dialog 内嵌使用 false 避免落到模态层外。 */
  portalled?: boolean
  /** 是否强制挂载浮层内容；嵌套 Dialog 中可避免 Radix Presence 首次打开丢失内容。 */
  forceMount?: boolean
  /** 会话累计运行耗时（ms）；大于 0 时在大纲顶栏附紧凑摘要（文档大纲不传）。 */
  totalRunMs?: number
  /** 可选会话实时计时输入（浮层打开且在途时同步累加本轮耗时；关闭时不挂载定时器）。 */
  liveTiming?: ConversationTimingInput
  /** 大纲摘要展示轮次数（缺省回退大纲内人类提问轮数）。 */
  summaryTurnCount?: number
  /** 是否存在更早的未加载历史分页。 */
  hasEarlierHistory?: boolean
  loadingEarlierHistory?: boolean
  onLoadEarlierHistory?: () => void
  /** Controlled open state (optional; lets ConversationPane defer full outline construction while closed). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Explicit non-empty flag when `nodes` is lazily computed only while `open === true`. */
  hasItems?: boolean
  onSelectTarget: (target: OutlineJumpTarget) => void
}

/**
 * 会话顶栏「大纲」快速导航浮层（基于 Radix Popover 原语）：
 * - 按时间序列出全部提问回合（#1, #2...）、助手回复摘要/Markdown 标题（H1~H3）、
 *   业务卡（tool.view 顶层卡与 timeline.renderer 接管卡）与上下文分割线；
 * - 支持实时关键词检索（提问/回复全文、卡片摘要与标题）与「全部 / 仅提问」切换；
 * - 支持 ↑ / ↓ / Enter 键盘快速跳转，点击或回车后平滑定位并闪烁高亮目标消息
 *   （标题按 headingIndex、业务卡按 cardId 二级锚精确到具体卡片 DOM）。
 */
export function ConversationOutlinePopover({
  nodes,
  activeNodeKey,
  triggerLabel,
  triggerTitle,
  badgeCount,
  searchPlaceholder,
  accessibilityLabel,
  showModeToggle = true,
  portalled = true,
  forceMount,
  totalRunMs,
  liveTiming,
  summaryTurnCount,
  hasEarlierHistory = false,
  loadingEarlierHistory = false,
  onLoadEarlierHistory,
  open: openProp,
  onOpenChange,
  hasItems,
  onSelectTarget,
}: ConversationOutlinePopoverProps) {
  const { t } = useWebLocale()
  const effectiveTriggerLabel = triggerLabel ?? t('conv.outline.trigger')
  const effectiveSearchPlaceholder = searchPlaceholder ?? t('conv.outline.searchPlaceholder')
  const effectiveAccessibilityLabel = accessibilityLabel ?? t('conv.outline.accessibility')
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = openProp ?? uncontrolledOpen
  const setOpen = useCallback(
    (next: boolean): void => {
      if (openProp === undefined) setUncontrolledOpen(next)
      onOpenChange?.(next)
    },
    [openProp, onOpenChange],
  )
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<OutlineFilterMode>('dialogue')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const awaitingInitialAnchorRef = useRef(false)

  const liveClockActive =
    open &&
    liveTiming !== undefined &&
    (liveTiming.status === 'working' ||
      liveTiming.status === 'blocked' ||
      (typeof liveTiming.pendingAskCount === 'number' && liveTiming.pendingAskCount > 0)) &&
    typeof liveTiming.runStartedAt === 'number' &&
    Number.isFinite(liveTiming.runStartedAt) &&
    liveTiming.runStartedAt >= 0
  const liveNowMs = useSharedNowMs(liveClockActive)
  const resolvedTiming = liveTiming !== undefined ? resolveConversationTiming(liveTiming, liveNowMs) : undefined
  const effectiveTotalRunMs =
    resolvedTiming?.totalRunMs !== undefined
      ? resolvedTiming.totalRunMs
      : typeof totalRunMs === 'number' && Number.isFinite(totalRunMs) && totalRunMs > 0
        ? totalRunMs
        : undefined
  const effectiveMode: OutlineFilterMode = showModeToggle ? mode : 'all'
  const turnCount = useMemo(() => (open || badgeCount === undefined ? countOutlineTurns(nodes) : badgeCount), [open, badgeCount, nodes])
  const displayCount = badgeCount ?? turnCount
  const summaryTurns = summaryTurnCount ?? displayCount
  const outlineSummaryText =
    open && effectiveTotalRunMs !== undefined && effectiveTotalRunMs > 0
      ? (() => {
          const duration =
            resolvedTiming?.currentRunMs !== undefined
              ? formatStopwatchMs(effectiveTotalRunMs)
              : formatDurationMs(effectiveTotalRunMs)
          return summaryTurns > 0
            ? t('conv.outline.summaryTurnsAndTotal', { count: summaryTurns, duration })
            : t('conv.outline.summaryTotalOnly', { duration })
        })()
      : ''
  const hasFilterableNodes = useMemo(
    () =>
      open &&
      nodes.some(
        (n) => (n.kind === 'human' && n.origin !== 'human') || (n.kind !== 'human' && n.kind !== 'divider'),
      ),
    [open, nodes],
  )

  const filtered = useMemo(
    () => (open || forceMount ? filterOutlineNodes(nodes, { query, mode: effectiveMode }) : []),
    [open, forceMount, nodes, query, effectiveMode],
  )

  // 打开浮层时：默认将键盘焦点索引对齐到当前激活项（若存在），否则置为最后一项（最新提问）或首项。
  useEffect(() => {
    if (!open) {
      awaitingInitialAnchorRef.current = false
      setQuery('')
      return
    }
    if (activeNodeKey !== undefined) {
      awaitingInitialAnchorRef.current = false
      const idx = filtered.findIndex((n) => n.key === activeNodeKey)
      if (idx >= 0) {
        setSelectedIdx(idx)
        return
      }
    } else {
      awaitingInitialAnchorRef.current = true
    }
    setSelectedIdx(filtered.length > 0 ? filtered.length - 1 : 0)
  }, [open])

  // 当阅读锚点在打开浮层的同一提交布局阶段同步就绪时，对齐初始键盘高亮项。
  useEffect(() => {
    if (!open || !awaitingInitialAnchorRef.current || activeNodeKey === undefined) return
    awaitingInitialAnchorRef.current = false
    if (query !== '') return
    const idx = filtered.findIndex((n) => n.key === activeNodeKey)
    if (idx >= 0) setSelectedIdx(idx)
  }, [open, activeNodeKey, filtered, query])

  // 搜索词或过滤开关变化时重置选中索引
  useEffect(() => {
    setSelectedIdx(0)
  }, [query, effectiveMode])

  // 键盘移动或初次打开时将选中项滚动进浮层可视区
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-outline-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [open, selectedIdx])

  if (!(hasItems ?? nodes.length > 0)) return null

  const triggerSelect = (node: OutlineNode): void => {
    setOpen(false)
    onSelectTarget({
      entryId: node.entryId,
      nodeKey: node.key,
      ...(node.kind === 'heading' ? { headingIndex: node.headingIndex } : {}),
      ...(node.kind === 'card' && node.cardId !== undefined ? { cardId: node.cardId } : {}),
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (filtered.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((i) => (i + 1) % filtered.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((i) => (i - 1 + filtered.length) % filtered.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = filtered[selectedIdx]
      if (target !== undefined) triggerSelect(target)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`btn btn-sm conversation-outline-trigger${open ? ' is-open' : ''}`}
          aria-label={t('conv.outline.nav', { label: effectiveAccessibilityLabel })}
          title={triggerTitle ?? t('conv.outline.triggerTitle', { count: displayCount })}
        >
          <HelmxIcon name="list-tree" size={12} />
          <span className="pane-action-label">{effectiveTriggerLabel}</span>
          {displayCount > 0 ? (
            <span className="badge badge-neutral tabular-nums">{displayCount}</span>
          ) : null}
        </button>
      </PopoverTrigger>
      {!forceMount || open ? (
      <PopoverContent
        portalled={portalled}
        forceMount={forceMount ? true : undefined}
        align="end"
        sideOffset={6}
        className="conversation-outline-popover"
        aria-label={effectiveAccessibilityLabel}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          searchInputRef.current?.focus()
        }}
        onCloseAutoFocus={(e) => {
          const active = document.activeElement
          if (active !== null && active !== document.body && active !== document.documentElement) {
            e.preventDefault()
          }
        }}
        onKeyDown={handleKeyDown}
      >
          <div className="conversation-outline-header">
            <div className="search-box conversation-outline-search">
              <HelmxIcon name="search" size={13} />
              <input
                ref={searchInputRef}
                type="text"
                aria-label={t('conv.outline.filter', { label: effectiveAccessibilityLabel })}
                placeholder={effectiveSearchPlaceholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query !== '' ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon-xs"
                  aria-label={t('conv.outline.clearSearchAria')}
                  title={t('conv.outline.clearSearch')}
                  onClick={() => {
                    setQuery('')
                    searchInputRef.current?.focus()
                  }}
                >
                  <HelmxIcon name="x" size={11} />
                </button>
              ) : null}
            </div>
            {hasFilterableNodes && showModeToggle ? (
              <div className="segmented-control conversation-outline-mode" role="group" aria-label={t('conv.outline.modeSwitch')}>
                {(
                  [
                    ['dialogue', t('conv.outline.modeDialogue')],
                    ['questions', t('conv.outline.modeQuestions')],
                    ['all', t('common.all')],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`segmented-control-btn${mode === value ? ' is-active' : ''}`}
                    aria-pressed={mode === value}
                    onClick={() => setMode(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {outlineSummaryText !== '' ? (
            <div className="conversation-outline-summary mono tabular-nums">
              {outlineSummaryText}
            </div>
          ) : null}

          {hasEarlierHistory && onLoadEarlierHistory !== undefined ? (
            <div className="conversation-outline-earlier-bar">
              <button
                type="button"
                className="btn btn-ghost btn-xs conversation-outline-earlier-btn"
                disabled={loadingEarlierHistory}
                onClick={() => onLoadEarlierHistory()}
              >
                <HelmxIcon name={loadingEarlierHistory ? 'loader' : 'arrow-up'} size={11} className={loadingEarlierHistory ? 'spin-slow' : undefined} />
                {loadingEarlierHistory ? t('conv.outline.loadingEarlier') : t('conv.outline.loadEarlier')}
              </button>
            </div>
          ) : null}

          <div ref={listRef} className="conversation-outline-list" role="listbox" aria-label={t('conv.outline.entries')}>
            {filtered.length === 0 ? (
              <div className="conversation-outline-empty">
                {t('conv.outline.noMatches')}
              </div>
            ) : (
              filtered.map((node, idx) => {
                const isSelected = idx === selectedIdx
                const isActive = activeNodeKey !== undefined && node.key === activeNodeKey

                if (node.kind === 'divider') {
                  return (
                    <button
                      key={node.key}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-outline-idx={idx}
                      className={`conversation-outline-item conversation-outline-divider${isSelected ? ' is-selected' : ''}`}
                      onMouseEnter={() => setSelectedIdx(idx)}
                      onClick={() => triggerSelect(node)}
                    >
                      <HelmxIcon name={node.divider === 'reset' ? 'rotate-ccw' : 'archive'} size={11} />
                      <span className="conversation-outline-divider-label">{node.label}</span>
                    </button>
                  )
                }

                if (node.kind === 'heading') {
                  return (
                    <button
                      key={node.key}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-outline-idx={idx}
                      className={`conversation-outline-item conversation-outline-heading conversation-outline-heading-h${node.level}${isSelected ? ' is-selected' : ''}${isActive ? ' is-current' : ''}`}
                      title={node.text}
                      onMouseEnter={() => setSelectedIdx(idx)}
                      onClick={() => triggerSelect(node)}
                    >
                      <span className="conversation-outline-heading-marker mono">H{node.level}</span>
                      <span className="conversation-outline-item-label">{node.text}</span>
                    </button>
                  )
                }

                if (node.kind === 'assistant') {
                  const timeText = formatMessageTime(node.createdAt)
                  const durationText =
                    node.durationMs !== undefined && node.durationMs > 0 ? formatDurationMs(node.durationMs) : ''
                  return (
                    <button
                      key={node.key}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-outline-idx={idx}
                      className={`conversation-outline-item conversation-outline-assistant${isSelected ? ' is-selected' : ''}${isActive ? ' is-current' : ''}`}
                      title={node.fullText !== '' ? node.fullText : node.label}
                      onMouseEnter={() => setSelectedIdx(idx)}
                      onClick={() => triggerSelect(node)}
                    >
                      <HelmxIcon
                        name={node.live ? 'loader' : 'sparkles'}
                        size={11}
                        className={node.live ? 'spin-slow' : undefined}
                      />
                      <span className="conversation-outline-item-label">{node.label}</span>
                      {node.status === 'failed' ? (
                        <span className="conversation-outline-status-badge">{t('conv.tool.statusFailed')}</span>
                      ) : null}
                      {durationText !== '' || timeText !== '' ? (
                        <span className="conversation-outline-meta mono tabular-nums">
                          {durationText !== '' ? (
                            <span className="conversation-outline-duration">{durationText}</span>
                          ) : null}
                          {timeText !== '' ? (
                            <span className="conversation-outline-time">{timeText}</span>
                          ) : null}
                        </span>
                      ) : null}
                    </button>
                  )
                }

                if (node.kind === 'card') {
                  const cardIcon =
                    node.status === 'running' ? 'loader' : node.status === 'error' ? 'alert-triangle' : 'layout-grid'
                  return (
                    <button
                      key={node.key}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-outline-idx={idx}
                      {...(node.status !== undefined ? { 'data-status': node.status } : {})}
                      className={`conversation-outline-item conversation-outline-card${isSelected ? ' is-selected' : ''}${isActive ? ' is-current' : ''}`}
                      title={node.searchText}
                      onMouseEnter={() => setSelectedIdx(idx)}
                      onClick={() => triggerSelect(node)}
                    >
                      <HelmxIcon
                        name={cardIcon}
                        size={11}
                        className={node.status === 'running' ? 'spin-slow' : undefined}
                      />
                      <span className="conversation-outline-item-label">{node.label}</span>
                    </button>
                  )
                }

                const timeText = formatMessageTime(node.createdAt)
                return (
                  <button
                    key={node.key}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    data-outline-idx={idx}
                    className={`conversation-outline-item conversation-outline-human${isSelected ? ' is-selected' : ''}${isActive ? ' is-current' : ''}`}
                    title={node.fullText}
                    onMouseEnter={() => setSelectedIdx(idx)}
                    onClick={() => triggerSelect(node)}
                  >
                    <span className="conversation-outline-turn-badge mono tabular-nums">
                      #{node.turnIndex}
                    </span>
                    {node.origin !== 'human' ? (
                      <HelmxIcon
                        name={node.origin === 'trigger' ? 'webhook' : 'bot'}
                        size={11}
                        className="conversation-outline-origin-icon"
                      />
                    ) : null}
                    <span className="conversation-outline-item-label">{node.label}</span>
                    {timeText !== '' ? (
                      <span className="conversation-outline-time mono tabular-nums">{timeText}</span>
                    ) : null}
                  </button>
                )
              })
            )}
          </div>
      </PopoverContent>
      ) : null}
    </Popover>
  )
}
