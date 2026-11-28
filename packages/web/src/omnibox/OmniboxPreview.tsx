import React from 'react'
import { resolveLocalizedText, type CommandSpec, type HelmxLocale } from '@helmx/protocol/browser'
import { Button, Stack } from '@helmx/ui'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import type { QualifiedCommand } from '../lib/commands-model.js'
import { PluginUiView } from '../ui/PluginUiView.js'

export interface OmniboxPreviewProps {
  pluginId: string
  spec: CommandSpec
  matchingCommand: QualifiedCommand | undefined
  conversationId: number | undefined
  locale: HelmxLocale
  t: WebMessageTranslator
  onRun: () => void
  onCollapse: () => void
}

export function OmniboxPreview({
  pluginId,
  spec,
  matchingCommand,
  conversationId,
  locale,
  t,
  onRun,
  onCollapse,
}: OmniboxPreviewProps): React.JSX.Element {
  return (
    <div className="palette-preview">
      <div className="palette-preview-header">
        <span className="palette-preview-title">
          {resolveLocalizedText(spec.title, locale)} · {pluginId}
        </span>
        <Stack direction="horizontal" gap="xs" align="center" className="palette-preview-actions">
          {spec.actionId !== undefined && matchingCommand !== undefined && (
            <Button variant="primary" size="sm" onClick={onRun}>
              {t('modals.palette.runAction')}
            </Button>
          )}
          <Button
            size="sm"
            onClick={onCollapse}
            aria-label={t('modals.palette.closePreview')}
          >
            {t('common.collapse')}
          </Button>
        </Stack>
      </div>
      <PluginUiView
        pluginId={pluginId}
        spec={spec}
        conversationId={conversationId}
        slotProps={conversationId !== undefined ? { conversationId } : undefined}
        label={t('modals.palette.previewLabel', { id: spec.id })}
      />
    </div>
  )
}
