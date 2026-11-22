/** builtin:token-speed composer status badge (Fast Refresh compliant). */
import type { ReactNode } from 'react'
import type { ComposerScopeProps } from '@helmx/protocol'
import { usePluginLocale, usePluginSessionDoc } from '@helmx/plugin-client'
import type { TokenSpeedStatus } from '../contracts.js'
import { tokenSpeedLabelOf } from './label.ts'
import './index.css'

export function TokenSpeedStatusBadge(_props: ComposerScopeProps): ReactNode {
  const status = usePluginSessionDoc<TokenSpeedStatus | null>('speed')
  const locale = usePluginLocale()
  const label = status ? tokenSpeedLabelOf(status, locale) : null
  if (!label) return null
  return <span className="token-speed-status mono tabular-nums" title={label.title}>{label.text}</span>
}
