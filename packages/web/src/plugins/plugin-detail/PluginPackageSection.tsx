import React from 'react'
import type { PluginDoctorReport, PluginManagedMeta } from '@helmx/protocol/browser'
import { Badge, Button, Card, HelmxIcon, Input, KvGrid, Stack } from '@helmx/ui'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import {
  detectPluginSourceKind,
  formatInstalledAt,
  isInstallSourceSubmittable,
  pluginSourceBadgeLabel,
  pluginSourceDisplayText,
} from '../plugin-package-model.js'
import { PluginDoctorChecks } from '../PluginDoctorChecks.js'
import type { PluginPackageOp } from './use-plugin-drawer-actions.js'

export interface PluginPackageSectionProps {
  managed: PluginManagedMeta
  packageOp: PluginPackageOp
  editingSource: boolean
  sourceDraft: string
  externalUpdating: boolean
  updateDoctorReport: PluginDoctorReport | null
  onEditingChange: (editing: boolean) => void
  onSourceDraftChange: (draft: string) => void
  onUpdate: () => void
  onRemoveRequest: () => void
}

/** 受管插件包分节：来源元数据（可换源）、已安装版本 / 时间与更新 / 卸载操作（内置或非受管插件不渲染）。 */
export function PluginPackageSection({
  managed,
  packageOp,
  editingSource,
  sourceDraft,
  externalUpdating,
  updateDoctorReport,
  onEditingChange,
  onSourceDraftChange,
  onUpdate,
  onRemoveRequest,
}: PluginPackageSectionProps): React.JSX.Element {
  const { locale, t } = useWebLocale()
  const operationsLocked = packageOp !== 'idle' || externalUpdating
  const draftTrimmed = sourceDraft.trim()
  const draftHint = detectPluginSourceKind(draftTrimmed, t)
  const draftSubmittable = draftTrimmed !== '' && isInstallSourceSubmittable(draftTrimmed)
  const installedAt = formatInstalledAt(managed.installedAt, locale)

  return (
    <Card
      variant="subtle"
      title={
        <Stack direction="horizontal" gap="xs" align="center" inline>
          <HelmxIcon name="boxes" size={13} />
          <span>{t('plugins.package.sectionTitle')}</span>
        </Stack>
      }
    >
      <KvGrid
        className="plugin-package-meta"
        items={[
          {
            key: t('plugins.package.sourceLabel'),
            value: (
              <Stack direction="vertical" gap="xs">
                <Stack direction="horizontal" gap="xs" align="center" wrap className="plugin-package-source-row">
                  <Badge tone="neutral" mono data-source-kind={managed.source.kind}>
                    {pluginSourceBadgeLabel(managed.source, t)}
                  </Badge>
                  <span className="mono selectable plugin-package-source-text">
                    {pluginSourceDisplayText(managed.source)}
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={operationsLocked}
                    onClick={() => {
                      if (editingSource) {
                        onEditingChange(false)
                        onSourceDraftChange('')
                      } else {
                        onEditingChange(true)
                        onSourceDraftChange(managed.source.raw)
                      }
                    }}
                  >
                    {editingSource ? t('common.cancel') : t('plugins.package.changeSource')}
                  </Button>
                </Stack>
                {editingSource && (
                  <Stack direction="vertical" gap="xs" className="plugin-package-source-editor">
                    <Input
                      mono
                      type="text"
                      value={sourceDraft}
                      invalid={draftTrimmed !== '' && draftHint.kind === 'unknown'}
                      placeholder={t('plugins.package.newSourcePlaceholder')}
                      aria-label={t('plugins.package.changeSource')}
                      spellCheck={false}
                      autoComplete="off"
                      disabled={operationsLocked}
                      onChange={(e) => onSourceDraftChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && draftSubmittable) {
                          e.preventDefault()
                          onUpdate()
                        }
                      }}
                    />
                    {draftTrimmed !== '' && (
                      <span
                        className={`plugin-source-hint${draftHint.kind === 'unknown' ? ' is-unknown' : ''}`}
                        data-source-kind={draftHint.kind}
                      >
                        {draftHint.label}
                      </span>
                    )}
                  </Stack>
                )}
              </Stack>
            ),
          },
          ...(managed.installedVersion !== ''
            ? [
                {
                  key: t('plugins.package.installedVersionLabel'),
                  value: <span className="mono tabular-nums">{managed.installedVersion}</span>,
                },
              ]
            : []),
          ...(installedAt !== ''
            ? [
                {
                  key: t('plugins.package.installedAtLabel'),
                  value: <span className="tabular-nums">{installedAt}</span>,
                },
              ]
            : []),
        ]}
      />
      <Stack direction="horizontal" gap="sm" align="center" wrap className="plugin-package-actions">
        <Button
          size="sm"
          icon={
            <HelmxIcon
              name="refresh-cw"
              size={12}
              className={packageOp === 'updating' || externalUpdating ? 'spin' : undefined}
            />
          }
          disabled={
            operationsLocked ||
            (editingSource && !isInstallSourceSubmittable(sourceDraft))
          }
          onClick={onUpdate}
        >
          {packageOp === 'updating' || externalUpdating
            ? t('plugins.package.updating')
            : t('plugins.package.updatePlugin')}
        </Button>
        <Button
          variant="danger"
          size="sm"
          icon="trash-2"
          disabled={operationsLocked}
          onClick={onRemoveRequest}
        >
          {packageOp === 'removing' ? t('plugins.package.uninstalling') : t('plugins.package.uninstallPlugin')}
        </Button>
      </Stack>
      {updateDoctorReport && <PluginDoctorChecks report={updateDoctorReport} />}
    </Card>
  )
}
