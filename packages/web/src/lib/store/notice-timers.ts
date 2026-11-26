/**
 * Toast notice queue and auto-dismiss / hover-pause timer controller for HelmxExternalStore.
 */
import type { ToastNotice } from '../types.js'
import { applyUpdater, emptyPlan, ESC_ABORT_NOTICE_ID } from './helpers.js'
import type { NotifyPlan, StoreUpdater } from './types.js'

const NOTICE_RESUME_GRACE_MS = 800

interface NoticeTimerEntry {
  timer: ReturnType<typeof setTimeout> | null
  remainingMs: number
  startedAt: number | null
}

export class StoreNoticeController {
  private noticesState: ToastNotice[] = []
  private noticeSequence = 0
  private readonly infoNoticeDurationMs: number
  private readonly noticeTimers = new Map<string, NoticeTimerEntry>()
  private readonly emit: (plan: NotifyPlan) => void

  constructor(options: { infoNoticeDurationMs: number; onEmit: (plan: NotifyPlan) => void }) {
    this.infoNoticeDurationMs = options.infoNoticeDurationMs
    this.emit = options.onEmit
  }

  getNotices = (): ToastNotice[] => this.noticesState

  setNotices = (
    update: StoreUpdater<ToastNotice[]>,
    plan = emptyPlan(),
    deferEmit = false,
  ): void => {
    const prev = this.noticesState
    const next = applyUpdater(prev, update)
    if (next === prev) return
    this.noticesState = next
    plan.domains.add('notices')
    plan.domains.add('all')
    if (!deferEmit) this.emit(plan)
  }

  clearTimer(id: string): void {
    const entry = this.noticeTimers.get(id)
    if (entry === undefined) return
    if (entry.timer !== null) clearTimeout(entry.timer)
    this.noticeTimers.delete(id)
  }

  clearAllTimers(): void {
    for (const entry of this.noticeTimers.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer)
    }
    this.noticeTimers.clear()
  }

  private scheduleTimer(id: string, delayMs: number): void {
    this.clearTimer(id)
    const entry: NoticeTimerEntry = {
      timer: null,
      remainingMs: delayMs,
      startedAt: Date.now(),
    }
    entry.timer = setTimeout(() => {
      this.noticeTimers.delete(id)
      this.dismissNotice(id)
    }, delayMs)
    this.noticeTimers.set(id, entry)
  }

  dismissNotice = (id: string): void => {
    this.clearTimer(id)
    if (!this.noticesState.some((item) => item.id === id)) return
    this.setNotices((prev) => prev.filter((notice) => notice.id !== id))
  }

  pauseNoticeTimer = (id: string): void => {
    const entry = this.noticeTimers.get(id)
    if (entry === undefined || entry.timer === null) return
    clearTimeout(entry.timer)
    entry.timer = null
    const elapsed = entry.startedAt !== null ? Math.max(0, Date.now() - entry.startedAt) : 0
    const minGrace = Math.min(this.infoNoticeDurationMs, NOTICE_RESUME_GRACE_MS)
    entry.remainingMs = Math.max(minGrace, entry.remainingMs - elapsed)
    entry.startedAt = null
  }

  resumeNoticeTimer = (id: string): void => {
    const entry = this.noticeTimers.get(id)
    if (entry === undefined || entry.timer !== null) return
    if (!this.noticesState.some((item) => item.id === id)) {
      this.noticeTimers.delete(id)
      return
    }
    this.scheduleTimer(id, entry.remainingMs)
  }

  pushNotice = (notice: Omit<ToastNotice, 'id' | 'createdAt'>): void => {
    const id = `notice-${++this.noticeSequence}`
    for (const existing of this.noticesState) {
      if (existing.title === notice.title && existing.body === notice.body) {
        this.clearTimer(existing.id)
      }
    }
    this.setNotices((prev) => [
      ...prev.filter((item) => item.title !== notice.title || item.body !== notice.body),
      { ...notice, id, createdAt: Date.now() },
    ])
    if (notice.level === 'info') {
      this.scheduleTimer(id, this.infoNoticeDurationMs)
    }
  }

  clearEscAbortNotice(plan: NotifyPlan, deferEmit: boolean): void {
    if (!this.noticesState.some((item) => item.id === ESC_ABORT_NOTICE_ID)) return
    this.setNotices((prev) => prev.filter((item) => item.id !== ESC_ABORT_NOTICE_ID), plan, deferEmit)
  }
}
