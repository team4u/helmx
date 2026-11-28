import React from 'react'
import { TabCount, Tabs, TabsList, TabsTrigger } from '@helmx/ui'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { omniboxScopeLabelKey } from './omnibox-labels.js'
import { OMNIBOX_SCOPES, type OmniboxScope, type OmniboxScopeCounts } from './types.js'

export interface OmniboxScopeBarProps {
  effectiveScope: OmniboxScope
  scopeCounts: OmniboxScopeCounts
  onSelectScope: (scope: OmniboxScope) => void
}

export function OmniboxScopeBar({
  effectiveScope,
  scopeCounts,
  onSelectScope,
}: OmniboxScopeBarProps): React.JSX.Element {
  const { t } = useWebLocale()
  return (
    <div className="omnibox-scope-bar">
      <Tabs
        variant="pills"
        size="sm"
        value={effectiveScope}
        onValueChange={(value) => {
          if (OMNIBOX_SCOPES.includes(value as OmniboxScope)) {
            onSelectScope(value as OmniboxScope)
          }
        }}
      >
        <TabsList scrollable aria-label={t('modals.omnibox.scope.aria')}>
          {OMNIBOX_SCOPES.map((scope) => (
            <TabsTrigger key={scope} value={scope} data-omnibox-scope={scope}>
              <span>{t(omniboxScopeLabelKey(scope))}</span>
              <TabCount>{scopeCounts[scope]}</TabCount>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  )
}
