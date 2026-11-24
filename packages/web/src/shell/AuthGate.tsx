import { useState, type FormEvent } from 'react'
import { authApi } from '../lib/api.js'
import { Button, Card, Field, HelmxIcon, IconButton, Input, Stack } from '@helmx/plugin-client'
import { useAuthConnection, useStoreActions, useThemePreferencesState } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { LocaleMenuButton } from '../ui/LocaleMenuButton.js'

export function AuthGate() {
  const { authConfigured } = useAuthConnection()
  const { theme, themePreference } = useThemePreferencesState()
  const { onAuthenticated, toggleTheme } = useStoreActions()
  const { t } = useWebLocale()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isSetup = !authConfigured
  const themeLabel =
    themePreference === 'system'
      ? t('shell.auth.themeSystem', {
          current: t(theme === 'dark' ? 'shell.theme.currentDark' : 'shell.theme.currentLight'),
        })
      : themePreference === 'light'
        ? t('shell.auth.themeLight')
        : t('shell.auth.themeDark')

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (isSetup && password.length < 8) {
      setError(t('shell.auth.passwordMin'))
      return
    }
    if (isSetup && password !== confirm) {
      setError(t('shell.auth.passwordMismatch'))
      return
    }
    setSubmitting(true)
    try {
      const res = isSetup
        ? await authApi.setup(password)
        : await authApi.login(password)
      await onAuthenticated(res.token)
    } catch (err) {
      // err.message stays verbatim (server/execution text); only the generic fallback is locale copy.
      setError(err instanceof Error ? err.message : t('shell.auth.failed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-gate">
      <Card className="auth-gate-card">
        <form onSubmit={(e) => void handleSubmit(e)}>
          <Stack direction="vertical" gap="lg">
            <div className="auth-gate-header">
              <div className="auth-gate-brand">
                <HelmxIcon name="sparkles" size={18} />
                <span className="auth-gate-title">{t('shell.auth.consoleTitle')}</span>
              </div>
              <Stack direction="horizontal" gap="xs" align="center">
                <LocaleMenuButton
                  className="sidebar-locale-toggle"
                  iconSize={14}
                  tooltipSide="top"
                  menuSide="bottom"
                  menuAlign="end"
                />
                <IconButton
                  variant="ghost"
                  size="sm"
                  icon={
                    <HelmxIcon
                      name={
                        themePreference === 'system'
                          ? 'monitor'
                          : themePreference === 'light'
                            ? 'sun'
                            : 'moon'
                      }
                      size={14}
                    />
                  }
                  label={themeLabel}
                  onClick={toggleTheme}
                />
              </Stack>
            </div>

            <div className="auth-gate-desc">
              {isSetup ? t('shell.auth.setupDesc') : t('shell.auth.unlockDesc')}
            </div>

            {error && (
              <div className="callout callout-error" role="alert">
                <HelmxIcon name="alert-circle" size={14} />
                <span>{error}</span>
              </div>
            )}

            <Field
              label={isSetup ? t('shell.auth.setPasswordLabel') : t('shell.auth.passwordLabel')}
              required
            >
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isSetup ? t('shell.auth.setPasswordPlaceholder') : t('shell.auth.passwordPlaceholder')}
                autoComplete={isSetup ? 'new-password' : 'current-password'}
                autoFocus
              />
            </Field>

            {isSetup && (
              <Field label={t('shell.auth.confirmLabel')} required>
                <Input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder={t('shell.auth.confirmPlaceholder')}
                  autoComplete="new-password"
                />
              </Field>
            )}

            <Button
              type="submit"
              variant="primary"
              icon={<HelmxIcon name="lock" size={13} />}
              pending={submitting}
            >
              {submitting ? t('shell.auth.verifying') : isSetup ? t('shell.auth.initialize') : t('shell.auth.unlock')}
            </Button>
          </Stack>
        </form>
      </Card>
    </div>
  )
}
