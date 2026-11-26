/** Minimal DOM or React keyboard event shape checked for active IME composition. */
export interface ImeKeyEventLike {
  isComposing?: boolean
  keyCode?: number
  nativeEvent?: {
    isComposing?: boolean
    keyCode?: number
  }
}

/**
 * Return true when a keyboard event originates inside an active IME composition
 * session (supporting both native KeyboardEvent and React SyntheticEvent).
 */
export function isImeComposing(event: ImeKeyEventLike, blockProcessKeyCode = true): boolean {
  const composing =
    event.nativeEvent !== undefined ? event.nativeEvent.isComposing : event.isComposing
  if (composing === true) return true
  if (!blockProcessKeyCode) return false
  return event.keyCode === 229 || event.nativeEvent?.keyCode === 229
}
