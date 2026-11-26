/**
 * Shared `/api/hub-update/status` polling coordinator for `HubUpdateCard` and `HubUpgradedNotice`.
 *
 * Deduplicates initial and periodic 60s status polls when both components are mounted simultaneously,
 * and resets all in-memory state cleanly as soon as the last subscriber unmounts.
 */
import { useEffect, useState } from 'react'
import { apiRequest } from '../lib/api.js'

export interface HubUpdateStatusSnapshot {
  active?: boolean
  currentVersion: string | null
  readyVersion?: string | null
  lastError?: string | null
  blocked?: { version: string; reason: string; at: string } | null
  upgradedFrom?: string | null
  changelogAvailable?: boolean
}

export const DEFAULT_HUB_STATUS_POLL_MS = 60_000

interface SubscriberEntry {
  pollMs: number
  onStatus: (next: HubUpdateStatusSnapshot) => void
}

const subscribers = new Map<symbol, SubscriberEntry>()
let latestStatus: HubUpdateStatusSnapshot | null = null
let inFlightController: AbortController | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let nextDueAt = 0

function effectivePollMs(): number {
  let min = DEFAULT_HUB_STATUS_POLL_MS
  for (const sub of subscribers.values()) {
    if (sub.pollMs > 0 && sub.pollMs < min) min = sub.pollMs
  }
  return min
}

function clearScheduledTimer(): void {
  if (timer !== undefined) {
    clearTimeout(timer)
    timer = undefined
  }
  nextDueAt = 0
}

function scheduleNextPoll(): void {
  clearScheduledTimer()
  if (subscribers.size === 0 || inFlightController !== null) return
  const delay = effectivePollMs()
  nextDueAt = Date.now() + delay
  timer = setTimeout(runSharedPoll, delay)
}

export function publishHubUpdateStatus(next: HubUpdateStatusSnapshot): void {
  if (subscribers.size === 0) return
  latestStatus = next
  for (const sub of subscribers.values()) {
    sub.onStatus(next)
  }
}

export async function fetchHubUpdateStatusOnce(signal?: AbortSignal): Promise<HubUpdateStatusSnapshot | null> {
  try {
    return await apiRequest<HubUpdateStatusSnapshot>('GET', '/api/hub-update/status', undefined, signal)
  } catch {
    return null
  }
}

function runSharedPoll(): void {
  clearScheduledTimer()
  if (subscribers.size === 0 || inFlightController !== null) return
  const controller = new AbortController()
  inFlightController = controller
  void fetchHubUpdateStatusOnce(controller.signal).then((next) => {
    if (inFlightController === controller) {
      inFlightController = null
    }
    if (controller.signal.aborted || subscribers.size === 0) return
    if (next !== null) {
      publishHubUpdateStatus(next)
    }
    scheduleNextPoll()
  })
}

export function useHubUpdateStatusPoll(pollMs = DEFAULT_HUB_STATUS_POLL_MS): [
  HubUpdateStatusSnapshot | null,
  (next: HubUpdateStatusSnapshot) => void,
] {
  const [status, setStatus] = useState<HubUpdateStatusSnapshot | null>(() =>
    subscribers.size > 0 ? latestStatus : null,
  )

  useEffect(() => {
    const id = Symbol('hub-update-status-subscriber')
    const wasEmpty = subscribers.size === 0
    subscribers.set(id, { pollMs, onStatus: setStatus })
    if (!wasEmpty && latestStatus !== null) {
      setStatus(latestStatus)
    }
    if (wasEmpty) {
      runSharedPoll()
    } else if (inFlightController === null) {
      const desiredDue = Date.now() + effectivePollMs()
      if (timer === undefined || desiredDue < nextDueAt) {
        scheduleNextPoll()
      }
    }
    return () => {
      subscribers.delete(id)
      if (subscribers.size === 0) {
        clearScheduledTimer()
        inFlightController?.abort()
        inFlightController = null
        latestStatus = null
      }
    }
  }, [pollMs])

  return [status, setStatus]
}
