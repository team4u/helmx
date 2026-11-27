/** Centered dialog to snapshot active model tiers into a reusable template (`builtin:tiers`). */
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { HelmxLocale, LocalizedText } from '@helmx/protocol/browser'
import {
  Button,
  Callout,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  Field,
  IconButton,
  Input,
  Stack,
  Textarea,
} from '@helmx/plugin-client'
import { validateTemplateForm } from './models.ts'
import { TIERS_COPY as C, tiersTemplateCountSummary } from './copy.ts'

export interface SaveTemplateDialogProps {
  open: boolean
  inline?: boolean
  activeTierCount: number
  pending: boolean
  error: string | null
  locale: HelmxLocale
  translate: (text: LocalizedText) => string
  onSubmit: (payload: { id: string; name: string; description?: string }) => void
  onClose: () => void
}

export function SaveTemplateDialog({
  open,
  inline,
  activeTierCount,
  pending,
  error,
  locale,
  translate: t,
  onSubmit,
  onClose,
}: SaveTemplateDialogProps): ReactNode {
  const [form, setForm] = useState({ id: '', name: '', description: '' })
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setForm({ id: '', name: '', description: '' })
      setLocalError(null)
    }
  }, [open])

  const displayError = localError ?? error

  const handleSubmit = (): void => {
    setLocalError(null)
    const checked = validateTemplateForm(form)
    if (!checked.ok) {
      setLocalError(checked.code === 'template_id_invalid' ? t(C.errTemplateIdInvalid) : t(C.errTemplateFields))
      return
    }
    onSubmit(checked.payload)
  }

  const handleInputKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && !pending) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleBodyKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing && !pending) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <Dialog
      open={open}
      inline={inline}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !pending) onClose()
      }}
    >
      <DialogPortal inline={inline}>
        <DialogOverlay className="modal-backdrop">
          <DialogContent className="modal tiers-template-dialog">
            <div className="modal-header">
              <DialogTitle className="modal-title">{t(C.templateSaveTitle)}</DialogTitle>
              <DialogClose asChild>
                <IconButton
                  variant="ghost"
                  size="sm"
                  icon="x"
                  label={t(C.close)}
                  disabled={pending}
                />
              </DialogClose>
            </div>
            <div className="modal-body" onKeyDown={handleBodyKeyDown}>
              <Stack gap="md">
                <DialogDescription className="text-muted">
                  {tiersTemplateCountSummary(activeTierCount, locale)}
                </DialogDescription>
                {displayError !== null && (
                  <Callout tone="err">
                    <span>{displayError}</span>
                  </Callout>
                )}
                <div className="tiers-form-pair">
                  <Field label={t(C.templateIdLabel)} required>
                    <Input
                      type="text"
                      mono
                      value={form.id}
                      disabled={pending}
                      placeholder={t(C.templateIdPlaceholder)}
                      onKeyDown={handleInputKeyDown}
                      onChange={(e) => {
                        setLocalError(null)
                        setForm((prev) => ({ ...prev, id: e.target.value }))
                      }}
                    />
                  </Field>
                  <Field label={t(C.templateNameLabel)} required>
                    <Input
                      type="text"
                      value={form.name}
                      disabled={pending}
                      placeholder={t(C.templateNamePlaceholder)}
                      onKeyDown={handleInputKeyDown}
                      onChange={(e) => {
                        setLocalError(null)
                        setForm((prev) => ({ ...prev, name: e.target.value }))
                      }}
                    />
                  </Field>
                </div>
                <Field label={t(C.templateDescLabel)}>
                  <Textarea
                    rows={2}
                    value={form.description}
                    disabled={pending}
                    placeholder={t(C.templateDescPlaceholder)}
                    onChange={(e) => {
                      setLocalError(null)
                      setForm((prev) => ({ ...prev, description: e.target.value }))
                    }}
                  />
                </Field>
              </Stack>
            </div>
            <div className="modal-footer">
              <Button variant="ghost" size="sm" disabled={pending} onClick={onClose}>
                {t(C.cancel)}
              </Button>
              <Button variant="primary" size="sm" icon="layers" pending={pending} disabled={pending} onClick={handleSubmit}>
                {pending ? t(C.saving) : t(C.templateSaveBtn)}
              </Button>
            </div>
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}
