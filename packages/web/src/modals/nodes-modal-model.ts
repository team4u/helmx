/**
 * Pure-function model for the compute node helpers:
 * node ID validation, controlled-machine enrollment command generation,
 * usage and uptime formatting. All side-effect free for easy unit testing and
 * Fast Refresh isolation.
 *
 * Display-copy functions take an optional `t` and default to the English
 * bridge translator.
 */

import type { NodeInfo } from '@helmx/protocol/browser'
import { formatBytes } from '../lib/format.js'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'

export { formatBytes }

/** Node ID constraint (same source as the kernel issueNodeToken validation: starts alphanumeric, may contain . _ -, max 128). */
export const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export type NodeIdValidation = { ok: true; nodeId: string } | { ok: false; error: string }

/** Validate an enrollment node ID input: trim, reserved names and charset rules. */
export function validateNodeIdInput(raw: string, t?: WebMessageTranslator): NodeIdValidation {
  const tt = t ?? englishWebTranslator
  const nodeId = raw.trim()
  if (nodeId === '') return { ok: false, error: tt('modals.nodeId.empty') }
  if (nodeId === 'local') return { ok: false, error: tt('modals.nodeId.localReserved') }
  if (!NODE_ID_PATTERN.test(nodeId)) {
    return { ok: false, error: tt('modals.nodeId.invalidChars') }
  }
  return { ok: true, nodeId }
}

export interface NodeConnectGuide {
  /** Foreground connection (debug): binds the JOIN token and stays in the foreground; Ctrl+C exits; no daemon installed. */
  connectCommand: string
  /** Start the daemon in the background: reuses the identity already bound on disk, no token needed. */
  startDaemonCommand: string
  /** One-line enrollment: binds the node identity with --token and starts detached in the background (recommended). */
  oneLineCommand: string
  serviceInstallCommand: string
  doctorCommand: string
}

/** Build the controlled-machine enrollment command set (hubOrigin e.g. http://192.168.1.10:3202). */
export function buildNodeConnectGuide(
  hubOrigin: string,
  issued: { nodeId: string; token: string },
): NodeConnectGuide {
  // connect stays in the foreground (only Ctrl/Cmd+C exits), so chaining with
  // && would never run the rest; one-line enrollment uses start -d: its
  // detach path supports binding the identity with --token and then spawning
  // the background daemon, and the child argv carries no token (avoiding
  // token leaks from long-running process command lines).
  return {
    connectCommand: `helmx-node connect ${hubOrigin} --token ${issued.token}`,
    startDaemonCommand: 'helmx-node start -d',
    oneLineCommand: `helmx-node start -d --hub ${hubOrigin} --token ${issued.token}`,
    serviceInstallCommand: 'helmx-node service install',
    doctorCommand: 'helmx-node doctor',
  }
}

/** Uptime formatting (days/hours/minutes; compact locale-neutral units). */
export function formatUptime(uptimeSec: number | undefined): string {
  if (uptimeSec === undefined || !Number.isFinite(uptimeSec) || uptimeSec < 0) return '--'
  const totalMin = Math.floor(uptimeSec / 60)
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const minutes = totalMin % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (parts.length < 2) parts.push(`${minutes}m`)
  return parts.join(' ')
}

export interface NodeUsageInfo {
  usedBytes: number
  totalBytes: number
  percent: number
  label: string
}

/** Node option label for conversation/profile pickers: id + local/offline annotation. */
export function nodeOptionLabel(node: NodeInfo, t?: WebMessageTranslator): string {
  const tt = t ?? englishWebTranslator
  if (node.kind === 'local') return tt('modals.nodeOption.local', { id: node.id })
  return node.online ? node.id : tt('modals.nodeOption.offline', { id: node.id })
}

/** Usage computation (free + total -> used / percent / label); missing data returns null. */
export function formatUsage(
  freeBytes: number | undefined,
  totalBytes: number | undefined,
  t?: WebMessageTranslator,
): NodeUsageInfo | null {
  if (
    freeBytes === undefined ||
    totalBytes === undefined ||
    !Number.isFinite(freeBytes) ||
    !Number.isFinite(totalBytes) ||
    totalBytes <= 0 ||
    freeBytes < 0 ||
    freeBytes > totalBytes
  ) {
    return null
  }
  const tt = t ?? englishWebTranslator
  const usedBytes = totalBytes - freeBytes
  const percent = Math.round((usedBytes / totalBytes) * 100)
  return {
    usedBytes,
    totalBytes,
    percent,
    label: tt('modals.nodeUsage.label', {
      used: formatBytes(usedBytes),
      total: formatBytes(totalBytes),
      percent,
    }),
  }
}
