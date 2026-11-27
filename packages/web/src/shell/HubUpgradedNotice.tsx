/**
 * Hub 被动升级一次性提示条（主舞台壳层顶部，与 HubUpdateCard 同域）：
 * - 数据来自 /api/hub-update/status 的 `upgradedFrom`（Hub 进程级「上次运行版本」对比，
 *   与浏览器无关）；`changelogAvailable` 决定是否给出「查看更新内容」入口；
 * - 「知道了」或打开过 changelog 即在本浏览器记为已读（localStorage 记当前版本），
 *   直到下次版本变化才重新出现——主动一键切换不经过这里（切换完成卡自带引导）。
 */
import { useState, type ReactNode } from 'react'
import { Button, Card, HelmxIcon, Stack } from '@helmx/ui'
import { useStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { markSeenVersion, readSeenVersion } from './hub-changelog-seen.js'
import { DEFAULT_HUB_STATUS_POLL_MS, useHubUpdateStatusPoll } from './hub-update-status.js'

export function HubUpgradedNotice(props: { pollMs?: number }): ReactNode | null {
  const pollMs = props.pollMs ?? DEFAULT_HUB_STATUS_POLL_MS
  const { t } = useWebLocale()
  const { setActiveModal } = useStoreActions()
  const [status] = useHubUpdateStatusPoll(pollMs)
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() => readSeenVersion())

  if (status === null || status.upgradedFrom == null || status.currentVersion === null) return null
  if (dismissedVersion === status.currentVersion || readSeenVersion() === status.currentVersion) return null

  const currentVersion = status.currentVersion
  const upgradedFrom = status.upgradedFrom

  const dismiss = (): void => {
    markSeenVersion(currentVersion)
    setDismissedVersion(currentVersion)
  }

  const openChangelog = (): void => {
    setActiveModal({ kind: 'hub-changelog', from: upgradedFrom })
    dismiss()
  }

  return (
    <Card variant="subtle" className="hub-update-card hub-upgraded-notice" role="status">
      <Stack direction="horizontal" gap="sm" align="center" wrap>
        <HelmxIcon name="check-circle" size={14} />
        <span className="hub-update-card-text">
          {t('shell.hubChangelog.upgraded', { from: upgradedFrom, version: currentVersion })}
        </span>
        {status.changelogAvailable === true ? (
          <Button size="sm" className="hub-update-card-action" onClick={openChangelog}>
            {t('shell.hubChangelog.viewChanges')}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="hub-update-card-action hub-update-card-dismiss"
          onClick={dismiss}
        >
          {t('shell.hubChangelog.dismiss')}
        </Button>
      </Stack>
    </Card>
  )
}
