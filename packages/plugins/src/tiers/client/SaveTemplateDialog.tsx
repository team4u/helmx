/** Centered dialog to snapshot active model tiers into a reusable preset template (`builtin:tiers`). */
import { useEffect, useState, type ReactNode } from 'react'
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
  HelmxIcon,
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

  return (
    <Dialog
      open={open}
      inline={inline}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !pending) onClose()
      }}
    >
      <DialogPortal inline={inline}>
        <DialogOverlay className="modal-backdrop" />
        <DialogContent className="modal" aria-describedby={undefined}>
          <div className="modal-header">
            <DialogTitle>{t(C.templateSaveTitle)}</DialogTitle>
            <DialogClose asChild>
              <button
                type="button"
                className="btn btn-ghost btn-icon-sm"
                disabled={pending}
                aria-label={t(C.close)}
                title={t(C.close)}
              >
                <HelmxIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>
          <div className="modal-body">
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
      </DialogPortal>
    </Dialog>
  )
}
