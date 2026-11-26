/**
 * 节点详情抽屉内复用的展示小原语（DOM 结构与类名保持与拆分前一致）。
 */
import type { ReactNode } from 'react'
import { CopyButton, HelmxIcon, Stack } from '@helmx/plugin-client'

/** KvGrid 等键值位的等宽可选中文本单元格。 */
export function MonoValue({ children }: { children: ReactNode }): ReactNode {
  return <span className="mono selectable">{children}</span>
}

/** 分节卡片标题：行首 13px 图标 + 文案。 */
export function NodeSectionTitle({ icon, label }: { icon: string; label: ReactNode }): ReactNode {
  return (
    <Stack direction="horizontal" gap="xs" align="center" inline>
      <HelmxIcon name={icon} size={13} />
      <span>{label}</span>
    </Stack>
  )
}

/** 可一键复制的命令 / 令牌行：等宽代码块占满剩余宽度，右侧复制按钮。 */
export function CopyableCommandRow({ text, label }: { text: string; label?: string }): ReactNode {
  return (
    <Stack direction="horizontal" gap="sm" align="center" wrap>
      <code className="code-box selectable flex-1 mono">{text}</code>
      <CopyButton text={text} label={label} />
    </Stack>
  )
}
