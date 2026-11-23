/**
 * 移动端侧栏手势纯逻辑状态机与 DOM 冲突守卫（零 React 依赖，可直接单测）：
 *
 * - 非边缘正文区右滑打开、抽屉左滑关闭：避开 iOS/Android 左右 28px 系统返回边缘；
 * - 首段 12px 方向锁死（pending -> locked | canceled）：上下滑动斜偏绝不误弹侧栏；
 * - 起步 220ms + 总时长 600ms 时限 + 松手选区二次检查：屏蔽长按选字后向右拖选；
 * - DOM 冲突守卫：Radix 浮层/详情抽屉（Dialog/AlertDialog/Menu/Listbox/Popover）打开时、
 *   或触摸起点落在代码块/表格/输入框/横向滚动容器/touch-action:none/data-swipe-ignore 内时放行。
 */

/** 左右系统边缘让位宽度（避开 iOS 左边缘返回与 Android 双侧全面屏返回）。 */
export const SWIPE_EDGE_GUARD_PX = 28
/** 首段方向锁定距离阈值（达到即裁决水平锁定或永久取消）。 */
export const SWIPE_LOCK_DISTANCE_PX = 12
/** 水平主轴比值门槛（|dx| 必须严格大于 |dy| * 1.5）。 */
export const SWIPE_DIRECTION_RATIO = 1.5
/** 右滑打开侧栏的最小水平位移。 */
export const SWIPE_OPEN_THRESHOLD_PX = 56
/** 左滑关闭侧栏的最小水平位移。 */
export const SWIPE_CLOSE_THRESHOLD_PX = 48
/** 按下后走出首段锁定区的最晚时限（超期视为长按选字或停留，直接取消）。 */
export const SWIPE_LOCK_MAX_DELAY_MS = 220
/** 单次轻扫的总时长上限。 */
export const SWIPE_MAX_DURATION_MS = 600

export type DrawerSwipeDirection = 'open' | 'close'
export type DrawerSwipePhase = 'pending' | 'locked' | 'canceled'

export interface DrawerSwipeSession {
  direction: DrawerSwipeDirection
  phase: DrawerSwipePhase
  startX: number
  startY: number
  startTimeMs: number
  lastX: number
  lastY: number
}

export interface BeginDrawerSwipeInput {
  x: number
  y: number
  timeMs: number
  viewportWidth: number
  sidebarOpen: boolean
}

/** 初始化一次候选手势；起点落在左右系统边缘保护区则返回 null。 */
export function beginDrawerSwipe(input: BeginDrawerSwipeInput): DrawerSwipeSession | null {
  const { x, y, timeMs, viewportWidth, sidebarOpen } = input
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(viewportWidth)) return null
  if (viewportWidth <= SWIPE_EDGE_GUARD_PX * 2) return null
  if (x < SWIPE_EDGE_GUARD_PX || x > viewportWidth - SWIPE_EDGE_GUARD_PX) return null
  return {
    direction: sidebarOpen ? 'close' : 'open',
    phase: 'pending',
    startX: x,
    startY: y,
    startTimeMs: timeMs,
    lastX: x,
    lastY: y,
  }
}

export interface MoveDrawerSwipeInput {
  x: number
  y: number
  timeMs: number
}

/** 推进候选手势状态：首段满 12px 时锁死方向，超期或偏离主轴即永久 canceled。 */
export function moveDrawerSwipe(
  session: DrawerSwipeSession,
  input: MoveDrawerSwipeInput,
): DrawerSwipeSession {
  if (session.phase === 'canceled') return session
  const { x, y, timeMs } = input
  const elapsed = timeMs - session.startTimeMs
  if (elapsed < 0 || elapsed > SWIPE_MAX_DURATION_MS) {
    return { ...session, phase: 'canceled', lastX: x, lastY: y }
  }

  const dx = x - session.startX
  const dy = y - session.startY
  const absDx = Math.abs(dx)
  const absDy = Math.abs(dy)

  if (session.phase === 'pending') {
    if (Math.max(absDx, absDy) < SWIPE_LOCK_DISTANCE_PX) {
      if (elapsed > SWIPE_LOCK_MAX_DELAY_MS) {
        return { ...session, phase: 'canceled', lastX: x, lastY: y }
      }
      return { ...session, lastX: x, lastY: y }
    }
    if (elapsed > SWIPE_LOCK_MAX_DELAY_MS) {
      return { ...session, phase: 'canceled', lastX: x, lastY: y }
    }
    const directionMatches = session.direction === 'open' ? dx > 0 : dx < 0
    if (directionMatches && absDx > absDy * SWIPE_DIRECTION_RATIO) {
      return { ...session, phase: 'locked', lastX: x, lastY: y }
    }
    return { ...session, phase: 'canceled', lastX: x, lastY: y }
  }

  // 已锁定水平方向后若明显转为纵向或反向折返，则取消本次手势
  const stillSameSide = session.direction === 'open' ? dx > 0 : dx < 0
  if ((!stillSameSide && absDx >= SWIPE_LOCK_DISTANCE_PX) || absDy > absDx) {
    return { ...session, phase: 'canceled', lastX: x, lastY: y }
  }
  return { ...session, lastX: x, lastY: y }
}

export interface EndDrawerSwipeInput {
  x: number
  y: number
  timeMs: number
  hasNonCollapsedSelection: boolean
}

/** 结束手势裁决：返回应执行的动作（'open' | 'close'）或 null。 */
export function endDrawerSwipe(
  session: DrawerSwipeSession,
  input: EndDrawerSwipeInput,
): DrawerSwipeDirection | null {
  if (session.phase !== 'locked') return null
  if (input.hasNonCollapsedSelection) return null
  const elapsed = input.timeMs - session.startTimeMs
  if (elapsed < 0 || elapsed > SWIPE_MAX_DURATION_MS) return null
  const dx = input.x - session.startX
  const dy = input.y - session.startY
  if (Math.abs(dx) <= Math.abs(dy) * SWIPE_DIRECTION_RATIO) return null
  if (session.direction === 'open' && dx >= SWIPE_OPEN_THRESHOLD_PX) return 'open'
  if (session.direction === 'close' && dx <= -SWIPE_CLOSE_THRESHOLD_PX) return 'close'
  return null
}

/** 检测页面当前是否挂载了交互浮层（Radix Dialog/AlertDialog/Menu/Listbox/Popover，忽略 Tooltip）。 */
export function hasBlockingOverlay(doc: Document): boolean {
  if (doc.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') !== null) {
    return true
  }
  const poppers = doc.querySelectorAll('[data-radix-popper-content-wrapper]')
  for (const popper of poppers) {
    if (popper.querySelector('[role="tooltip"]') === null) return true
  }
  return false
}

/** 检测窗口当前是否存在非空文本选区（长按拖选保护）。 */
export function hasActiveTextSelection(win: Pick<Window, 'getSelection'> | null | undefined): boolean {
  const selection = win?.getSelection?.()
  if (selection === null || selection === undefined) return false
  return !selection.isCollapsed && String(selection).trim().length > 0
}

const EXCLUDED_TAG_NAMES = new Set(['PRE', 'TABLE', 'INPUT', 'TEXTAREA', 'SELECT', 'CANVAS'])
const EXCLUDED_CLASSES = ['composer-pills', 'mermaid-body', 'helmx-table-wrap']

export interface SwipeComputedStyleLike {
  overflowX: string
  touchAction: string
}

function defaultGetStyle(el: Element): SwipeComputedStyleLike {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return { overflowX: '', touchAction: '' }
  }
  const computed = window.getComputedStyle(el)
  return {
    overflowX: computed.overflowX ?? '',
    touchAction: computed.touchAction ?? '',
  }
}

/**
 * 判断触摸起点是否位于需要无条件豁免手势的元素内：
 * - 显式表单/代码/表格/画布/可编辑区/tablist/data-swipe-ignore；
 * - touch-action 为 none 或 pan-x（自带自定义触控拖拽或横向滑动）；
 * - 实际存在横向溢出的滚动容器（overflow-x: auto|scroll 且 scrollWidth > clientWidth + 1），
 *   无论 scrollLeft 是否回滚到头，均整块豁免以防边界惯性误弹侧栏。
 */
export function isSwipeExcludedTarget(
  target: EventTarget | null,
  boundary: Element | null,
  getStyle: (el: Element) => SwipeComputedStyleLike = defaultGetStyle,
): boolean {
  let node: Element | null =
    target instanceof Element
      ? target
      : target !== null && typeof target === 'object' && 'parentElement' in target
        ? ((target as { parentElement: Element | null }).parentElement ?? null)
        : null

  while (node !== null && node !== boundary) {
    if (EXCLUDED_TAG_NAMES.has(node.tagName)) return true
    if ((node as HTMLElement).isContentEditable === true) return true
    if (node.getAttribute('role') === 'tablist') return true
    if (node.hasAttribute('data-swipe-ignore')) return true
    for (const cls of EXCLUDED_CLASSES) {
      if (node.classList.contains(cls)) return true
    }

    const style = getStyle(node)
    const touchAction = style.touchAction.trim().toLowerCase()
    if (touchAction === 'none' || touchAction.includes('pan-x')) return true

    const overflowX = style.overflowX.trim().toLowerCase()
    if (
      (overflowX === 'auto' || overflowX === 'scroll') &&
      node.scrollWidth > node.clientWidth + 1
    ) {
      return true
    }
    node = node.parentElement
  }
  return false
}
