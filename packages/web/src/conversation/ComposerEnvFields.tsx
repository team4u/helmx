/**
 * Shared execution-node Select + working-directory input fields used by both
 * SessionEnvBar (empty conversation) and StandbyEnvBar (standby draft).
 */
import { useMemo } from 'react'
import type * as React from 'react'
import { HelmxIcon, Input, Select } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useNodes } from '../lib/store-context.js'
import { buildNodeSelectOptions } from '../modals/nodes-modal-model.js'

export interface ComposerEnvFieldsProps {
  nodeId: string
  cwd: string
  disabled: boolean
  nodeAriaLabel: string
  cwdAriaLabel: string
  cwdPlaceholder: string
  cwdInvalid?: boolean
  onNodeChange: (nextNodeId: string) => void
  onCwdChange: (nextCwd: string) => void
  onCwdKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
}

export function ComposerEnvFields({
  nodeId,
  cwd,
  disabled,
  nodeAriaLabel,
  cwdAriaLabel,
  cwdPlaceholder,
  cwdInvalid,
  onNodeChange,
  onCwdChange,
  onCwdKeyDown,
}: ComposerEnvFieldsProps): React.JSX.Element {
  const nodes = useNodes()
  const { t } = useWebLocale()

  const nodeOptions = useMemo(
    () =>
      buildNodeSelectOptions({
        nodes,
        selectedNodeId: nodeId,
        t,
        unknownNodeLabel: (id) => t('composer.env.nodeUnknownOption', { nodeId: id }),
      }),
    [nodes, nodeId, t],
  )

  return (
    <>
      <span className="composer-env-item">
        <Select
          className="composer-env-select"
          aria-label={nodeAriaLabel}
          disabled={disabled}
          value={nodeId}
          options={nodeOptions}
          onChange={(e) => onNodeChange(e.target.value)}
        />
      </span>
      <span className="composer-env-item composer-env-cwd-wrap">
        <HelmxIcon name="folder" size={12} className="composer-env-cwd-icon" />
        <Input
          mono
          className="composer-env-cwd-input"
          aria-label={cwdAriaLabel}
          invalid={cwdInvalid}
          value={cwd}
          disabled={disabled}
          placeholder={cwdPlaceholder}
          onChange={(e) => onCwdChange(e.target.value)}
          onKeyDown={onCwdKeyDown}
        />
      </span>
    </>
  )
}
