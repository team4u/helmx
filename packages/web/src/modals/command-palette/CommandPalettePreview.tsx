import React from 'react'
import { resolveLocalizedText, type CommandSpec, type HelmxLocale } from '@helmx/protocol/browser'
import { Button, Stack } from '@helmx/plugin-client'
import type { QualifiedCommand } from '../../lib/commands-model.js'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import { PluginUiView } from '../../ui/PluginUiView.js'

export interface CommandPalettePreviewProps {
  pluginId: string
  spec: CommandSpec
  /** 当前目录中仍可调用的同一命令（目录变化后可能不再存在，此时不渲染执行按钮）。 */
  matchingCommand: QualifiedCommand | undefined
  conversationId: number | undefined
  locale: HelmxLocale
  t: WebMessageTranslator
  onRun: () => void
  /** 收起预览并把焦点放回输入框。 */
  onCollapse: () => void
}

/** 插件 client 命令预览面板：标题 + 显式执行按钮 + PluginUiView 挂载。 */
export function CommandPalettePreview({
  pluginId,
  spec,
  matchingCommand,
  conversationId,
  locale,
  t,
  onRun,
  onCollapse,
}: CommandPalettePreviewProps): React.JSX.Element {
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
