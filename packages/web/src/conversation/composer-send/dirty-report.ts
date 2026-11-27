/**
 * Version auto-refresh dirty report: publishes the local draft dirtiness of this Composer
 * instance to the external bridge store (aggregated by `composer-dirty.ts`) and mirrors the
 * same snapshot into the keep-alive window sink.
 */
import { useEffect, useMemo } from 'react'
import { clearComposerDirty, setComposerDirty, type ComposerDirtySnapshot } from '../composer-dirty.js'
import type { ComposerSendCore } from './core.js'
import type { ComposerSendInput } from './types.js'

export function useComposerDirtyReport(core: ComposerSendCore, input: ComposerSendInput): void {
  const { text, attachments, editingEntryId, sending, uploading, runningCommand, conversationId } = core
  const { dirtyKey, dirtySink } = input

  // The snapshot is derived during render and mirrored into the keep-alive window sink right
  // away (latest-value ref pattern): an Activity hide can land before any effect ran, so the
  // owning window frame must be able to read the draft fact straight from render output.
  const dirtySnapshot = useMemo<ComposerDirtySnapshot>(
    () => ({
      hasDraftText: text.trim() !== '',
      editingEntry: editingEntryId !== null,
      hasAttachments: attachments.length > 0,
      busy: sending || uploading > 0 || runningCommand !== null,
    }),
    [text, editingEntryId, attachments, sending, uploading, runningCommand],
  )
  if (dirtySink != null) dirtySink.current = dirtySnapshot
  // Sync the external bridge on change; clear on unmount by the instance key (the dep array
  // holds only dirtyKey, so re-renders never clear the report twice).
  useEffect(() => {
    if (dirtyKey === undefined) return
    setComposerDirty(dirtyKey, dirtySnapshot, conversationId)
  }, [dirtyKey, dirtySnapshot, conversationId])
  useEffect(() => {
    if (dirtyKey === undefined) return
    return () => clearComposerDirty(dirtyKey)
  }, [dirtyKey])
}
