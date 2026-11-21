/**
 * Web-side re-export of the shared @helmx/plugin-client AlertDialog family.
 *
 * The private implementation (Radix wrapper + ConfirmDialog composition) was
 * consolidated into the SDK (see packages/plugin-client/src/ui/AlertDialog.tsx)
 * so host pages and plugin clients consume one implementation. Web consumers
 * keep their '../ui/AlertDialog.js' import paths; do not re-add a private copy
 * here — drift would defeat the consolidation.
 */
export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogTrigger,
  ConfirmDialog,
} from '@helmx/plugin-client'
export type {
  AlertDialogProps,
  AlertDialogPortalProps,
  AlertDialogOverlayProps,
  AlertDialogContentProps,
  AlertDialogTitleProps,
  AlertDialogDescriptionProps,
  AlertDialogActionProps,
  AlertDialogCancelProps,
  AlertDialogTriggerProps,
  ConfirmDialogProps,
} from '@helmx/plugin-client'
