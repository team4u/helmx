import React from 'react'
import type { PluginDoctorReport } from '@helmx/protocol/browser'
import { HelmxIcon, Stack } from '@helmx/plugin-client'
import { buildDoctorCheckItems } from './plugin-package-model.js'

export interface PluginDoctorChecksProps {
  report: PluginDoctorReport
}

/**
 * Render structured doctor preflight check items (shared by install modal and update drawer).
 */
export function PluginDoctorChecks({ report }: PluginDoctorChecksProps): React.JSX.Element {
  const items = buildDoctorCheckItems(report)
  return (
    <Stack direction="vertical" gap="sm" className="plugin-install-doctor" data-doctor-ok={report.ok}>
      {items.map((item) => (
        <div
          key={item.id}
          className={`plugin-doctor-check${item.ok ? '' : ' is-failed'}`}
        >
          <span className="plugin-doctor-check-mark">
            {item.ok ? <HelmxIcon name="check" size={11} /> : <HelmxIcon name="x" size={11} />}
          </span>
          <span className="plugin-doctor-check-body">
            <span className="plugin-doctor-check-label">{item.label}</span>
            {!item.ok && (
              <span className="plugin-doctor-check-error mono selectable">
                {item.errorText}
              </span>
            )}
          </span>
        </div>
      ))}
    </Stack>
  )
}
