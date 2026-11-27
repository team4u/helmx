/**
 * 命令面板空查询态的分组标题文案键（纯常量，从组件文件剥离以满足 Fast Refresh）。
 */
import type { PaletteGroupKey } from '../command-palette-model.js'

export const GROUP_LABEL_KEYS: Record<
  PaletteGroupKey,
  'modals.palette.group.context' | 'modals.palette.group.recent' | 'modals.palette.group.navigation' | 'modals.palette.group.commands'
> = {
  context: 'modals.palette.group.context',
  recent: 'modals.palette.group.recent',
  navigation: 'modals.palette.group.navigation',
  commands: 'modals.palette.group.commands',
}
