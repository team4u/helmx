import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './responsive.css'
import { App } from './App.js'
import { preloadWebLocale } from './i18n/catalog.js'
import { preloadAuthStatus } from './lib/api.js'
import { registerBrowserNotificationServiceWorker } from './lib/browser-notification.js'
import { resolveInitialLocale } from './lib/theme-preferences.js'
import { ViewBoundary } from '@helmx/plugin-client'

const container = document.getElementById('root')
if (container) {
  void registerBrowserNotificationServiceWorker()
  preloadAuthStatus()
  const initialLocale = resolveInitialLocale()
  void preloadWebLocale(initialLocale)
    .catch(() => {
      // Fallback: mount even if chunk preload fails so ViewBoundary/UI remains reachable.
    })
    .finally(() => {
      createRoot(container).render(
        <StrictMode>
          <ViewBoundary label="Helmx Console"><App /></ViewBoundary>
        </StrictMode>,
      )
    })
}
