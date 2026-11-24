/**
 * Hub 更新卡片（总览页顶部）：消费 `/api/hub-update/*` 产品路由。
 *
 * - 仅在存在就绪更新（readyVersion）或处于切换状态机（switching / switched / error）时渲染，
 *   平时零占地（unmanaged 的 docker/dev Hub 返回 active:false，同样不渲染）；
 * - 「立即切换」= POST apply（默认尊重忙时门控；hub_busy 时如实展示计数并提供
 *   「仍要切换」强制路径）；202 后进入切换中状态，轮询 status 直到新版本上线，
 *   再提示刷新页面加载新前端资产；
 * - 展示层不猜测：lastError / blocked / cooldown 原文透出，绝不伪造成功。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Card, HelmxIcon, Stack } from '@helmx/plugin-client'
import { apiRequest, ApiClientError } from '../lib/api.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  DEFAULT_HUB_STATUS_POLL_MS,
  fetchHubUpdateStatusOnce,
  publishHubUpdateStatus,
  useHubUpdateStatusPoll,
} from './hub-update-status.js'

type Phase = 'idle' | 'switching' | 'switched' | 'error'

const SWITCH_POLL_MS = 2_000
const SWITCH_TIMEOUT_MS = 180_000

export interface HubUpdateCardProps {
  pollMs?: number
  switchPollMs?: number
  switchTimeoutMs?: number
}

export function HubUpdateCard(props: HubUpdateCardProps): ReactNode | null {
  const pollMs = props.pollMs ?? DEFAULT_HUB_STATUS_POLL_MS
  const switchPollMs = props.switchPollMs ?? SWITCH_POLL_MS
  const switchTimeoutMs = props.switchTimeoutMs ?? SWITCH_TIMEOUT_MS
  const { t } = useWebLocale()
  const [status, setStatus] = useHubUpdateStatusPoll(pollMs)
  const [phase, setPhase] = useState<Phase>('idle')
  const [phaseDetail, setPhaseDetail] = useState<string | null>(null)
  const [busyCounts, setBusyCounts] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const targetRef = useRef<string | null>(null)
  const startedAtRef = useRef<number>(0)

  // Switching watch: poll across transient restart errors until the new version serves
  // or the timeout budget expires honestly.
  useEffect(() => {
    if (phase !== 'switching') return
    const target = targetRef.current
    if (target === null) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = (): void => {
      void fetchHubUpdateStatusOnce(controller.signal).then((next) => {
        if (controller.signal.aborted) return
        if (next !== null) {
          publishHubUpdateStatus(next)
          setStatus(next)
          if (next.currentVersion === target && (next.readyVersion ?? null) !== target) {
            setPhase('switched')
            return
          }
        }
        if (Date.now() - startedAtRef.current > switchTimeoutMs) {
          setPhase('error')
          setPhaseDetail(t('shell.hubUpdate.switchTimeout', { version: target }))
          return
        }
        timer = setTimeout(poll, switchPollMs)
      })
    }
    timer = setTimeout(poll, switchPollMs)
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [phase, setStatus, switchPollMs, switchTimeoutMs, t])

  const apply = useCallback(
    async (force: boolean): Promise<void> => {
      setApplying(true)
      setBusyCounts(null)
      setPhaseDetail(null)
      try {
        const result = await apiRequest<{ ok: boolean; switching: boolean; targetVersion: string }>(
          'POST',
          '/api/hub-update/apply',
          force ? { force: true } : {},
        )
        if (result.switching === true) {
          targetRef.current = result.targetVersion
          startedAtRef.current = Date.now()
          setPhase('switching')
        }
      } catch (error) {
        if (error instanceof ApiClientError && error.status === 409) {
          const code = error.code
          if (code === 'hub_busy') {
            const counts = ((error.details ?? {}) as { counts?: Record<string, number> }).counts ?? {}
            const parts = Object.entries(counts)
              .filter(([, value]) => value > 0)
              .map(([key, value]) => `${key}=${value}`)
              .join(' ')
            setBusyCounts(parts !== '' ? parts : 'busy')
          } else {
            setPhase('error')
            setPhaseDetail(error.message)
          }
        } else {
          setPhase('error')
          setPhaseDetail(error instanceof Error ? error.message : String(error))
        }
      } finally {
        setApplying(false)
      }
    },
    [],
  )

  const targetOrCurrentVersion = targetRef.current ?? status?.currentVersion ?? ''

  if (phase === 'switched') {
    return (
      <Card variant="subtle" className="hub-update-card hub-update-card-switched" role="status">
        <Stack direction="horizontal" gap="sm" align="center" wrap>
          <HelmxIcon name="check" size={14} />
          <span className="hub-update-card-text">
            {t('shell.hubUpdate.switched', { version: targetOrCurrentVersion })}
          </span>
          <Button size="sm" className="hub-update-card-action" onClick={() => window.location.reload()}>
            {t('shell.hubUpdate.reload')}
          </Button>
        </Stack>
      </Card>
    )
  }
  if (phase === 'switching') {
    return (
      <Card variant="subtle" className="hub-update-card hub-update-card-switching" role="status">
        <Stack direction="horizontal" gap="sm" align="center" wrap>
          <HelmxIcon name="loader" size={14} className="spin-slow" />
          <span className="hub-update-card-text">
            {t('shell.hubUpdate.switching', { version: targetOrCurrentVersion })}
          </span>
        </Stack>
      </Card>
    )
  }
  if (phase === 'error') {
    const readyVersion = status?.active === true ? (status.readyVersion ?? null) : null
    return (
      <Card variant="subtle" className="hub-update-card" role="status">
        <Stack direction="horizontal" gap="sm" align="center" wrap>
          <HelmxIcon name="alert-circle" size={14} />
          {readyVersion !== null ? (
            <span className="hub-update-card-text">
              {t('shell.hubUpdate.ready', {
                current: status?.currentVersion ?? '?',
                version: readyVersion,
              })}
            </span>
          ) : targetOrCurrentVersion !== '' ? (
            <span className="hub-update-card-text">
              {t('shell.hubUpdate.switching', { version: targetOrCurrentVersion })}
            </span>
          ) : null}
          {phaseDetail !== null ? (
            <span className="hub-update-card-error">{phaseDetail}</span>
          ) : null}
          {readyVersion !== null ? (
            <Button size="sm" className="hub-update-card-action" pending={applying} onClick={() => void apply(false)}>
              {t('shell.hubUpdate.apply')}
            </Button>
          ) : null}
        </Stack>
      </Card>
    )
  }
  if (status === null || status.readyVersion == null || status.active !== true) return null
  return (
    <Card variant="subtle" className="hub-update-card" role="status">
      <Stack direction="horizontal" gap="sm" align="center" wrap>
        <HelmxIcon name="download" size={14} />
        <span className="hub-update-card-text">
          {t('shell.hubUpdate.ready', {
            current: status.currentVersion ?? '?',
            version: status.readyVersion,
          })}
        </span>
        {busyCounts !== null ? (
          <span className="hub-update-card-busy">{t('shell.hubUpdate.busy', { counts: busyCounts })}</span>
        ) : null}
        {busyCounts !== null ? (
          <Button size="sm" className="hub-update-card-action" pending={applying} onClick={() => void apply(true)}>
            {t('shell.hubUpdate.forceApply')}
          </Button>
        ) : (
          <Button size="sm" className="hub-update-card-action" pending={applying} onClick={() => void apply(false)}>
            {t('shell.hubUpdate.apply')}
          </Button>
        )}
      </Stack>
    </Card>
  )
}
