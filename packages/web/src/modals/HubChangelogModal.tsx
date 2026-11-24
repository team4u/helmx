/**
 * Hub 变更日志弹窗（已安装版本 changelog，数据来自随包分发的 CHANGELOG.md）：
 * - 侧栏底部「版本与更新」入口打开全量视图；
 * - 总览升级提示条带 `from` 打开「本次更新」切片（跨过的版本，新版本在上）；
 * - 未随附 changelog（老 payload / 特殊部署）如实显示空态，不装假数据。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Badge, Callout, Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle, HelmxIcon, IconButton, LoadingState } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { apiRequest, ApiClientError } from '../lib/api.js'
import { useIsMobile } from '../conversation/composer-model.js'
import { MarkdownView } from '../conversation/MarkdownView.js'

interface ChangelogSection {
  version: string
  date: string
  markdown: string
}

interface ChangelogResponse {
  available: boolean
  version: string
  from?: string
  fromMatched?: boolean
  sections?: ChangelogSection[]
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'loaded'; data: ChangelogResponse }

export function HubChangelogModal({ from, onClose, inline = false }: { from?: string; onClose: () => void; inline?: boolean }): ReactNode {
  const { t } = useWebLocale()
  const isMobile = useIsMobile(680)
  const [state, setState] = useState<LoadState>({ phase: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    const path = from !== undefined && from !== '' ? `/api/hub-update/changelog?from=${encodeURIComponent(from)}` : '/api/hub-update/changelog'
    apiRequest<ChangelogResponse>('GET', path, undefined, controller.signal)
      .then((data) => setState({ phase: 'loaded', data }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState({ phase: 'error', message: error instanceof ApiClientError ? error.message : String(error) })
      })
    return () => controller.abort()
  }, [from])

  const data = state.phase === 'loaded' ? state.data : null
  const sections = data?.sections ?? []
  return (
    <Dialog open inline={inline} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal inline={inline}>
        <DialogOverlay className={`modal-backdrop${isMobile ? ' modal-fullscreen-backdrop' : ''}`}>
          <DialogContent
            className={`modal hub-changelog-modal${isMobile ? ' modal-fullscreen' : ''}`}
            aria-label={t('shell.hubChangelog.title')}
            style={isMobile ? undefined : { maxWidth: 'min(860px, 94vw)', maxHeight: '88vh' }}
          >
            <div className="modal-header hub-changelog-header">
              <span className="preview-modal-title-group">
                <HelmxIcon name="file-text" size={14} />
                <DialogTitle className="modal-title preview-modal-title">{t('shell.hubChangelog.title')}</DialogTitle>
                {data !== null ? (
                  <Badge tone="neutral" mono className="tabular-nums">v{data.version}</Badge>
                ) : null}
                {data?.from !== undefined ? (
                  <Badge tone="neutral" className="tabular-nums">
                    {data.fromMatched === true
                      ? t('shell.hubChangelog.range', { from: data.from, count: sections.length })
                      : t('shell.hubChangelog.rangeOlder', { from: data.from, count: sections.length })}
                  </Badge>
                ) : null}
              </span>
              <span className="preview-modal-actions">
                <DialogClose asChild>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    icon={<HelmxIcon name="x" size={14} />}
                    label={t('shell.hubChangelog.closeTitle')}
                  />
                </DialogClose>
              </span>
            </div>
            <div className="modal-body hub-changelog-body">
              {state.phase === 'loading' ? (
                <LoadingState
                  label={t('shell.hubChangelog.loading')}
                  iconSize={14}
                  className="preview-modal-loading"
                />
              ) : null}
              {state.phase === 'error' ? (
                <Callout tone="err">{state.message}</Callout>
              ) : null}
              {state.phase === 'loaded' && data !== null && data.available !== true ? (
                <Callout>{t('shell.hubChangelog.absent')}</Callout>
              ) : null}
              {state.phase === 'loaded' && data !== null && data.available === true && sections.length === 0 ? (
                <Callout>{t('shell.hubChangelog.emptyRange')}</Callout>
              ) : null}
              {sections.map((section) => (
                <section key={section.version} className="hub-changelog-section">
                  <header className="hub-changelog-section-head">
                    <span className="hub-changelog-version mono tabular-nums">v{section.version}</span>
                    <span className="hub-changelog-date tabular-nums">{section.date}</span>
                  </header>
                  <MarkdownView text={section.markdown} />
                </section>
              ))}
            </div>
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}
