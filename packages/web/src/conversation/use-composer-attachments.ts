/**
 * Shared paste, drag-and-drop, and hidden file-input attachment handlers for
 * both active-conversation Composer and AgentStandbyPane.
 */
import { useCallback, useRef, useState } from 'react'
import type * as React from 'react'

export interface UseComposerAttachmentsOptions {
  onFiles: (files: File[]) => void
  disabled?: boolean
}

export interface UseComposerAttachmentsResult {
  fileInputRef: React.RefObject<HTMLInputElement | null>
  dragging: boolean
  openFilePicker: () => void
  onPaste: (e: React.ClipboardEvent) => void
  onDragEnter: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}

export function useComposerAttachments({
  onFiles,
  disabled = false,
}: UseComposerAttachmentsOptions): UseComposerAttachmentsResult {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const dragDepthRef = useRef(0)
  const [dragging, setDragging] = useState(false)

  const openFilePicker = useCallback(() => {
    if (!disabled) fileInputRef.current?.click()
  }, [disabled])

  const onPaste = useCallback((e: React.ClipboardEvent) => {
    if (disabled) return
    const files = Array.from(e.clipboardData?.files ?? [])
    if (files.length > 0) {
      e.preventDefault()
      onFiles(files)
    }
  }, [disabled, onFiles])

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragDepthRef.current += 1
    if (!disabled && e.dataTransfer.types.includes('Files')) setDragging(true)
  }, [disabled])

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragging(false)
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragDepthRef.current = 0
    setDragging(false)
    if (disabled) return
    const files = Array.from(e.dataTransfer.files ?? [])
    if (files.length > 0) onFiles(files)
  }, [disabled, onFiles])

  const onFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (!disabled && files.length > 0) onFiles(files)
  }, [disabled, onFiles])

  return {
    fileInputRef,
    dragging,
    openFilePicker,
    onPaste,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    onFileInputChange,
  }
}
