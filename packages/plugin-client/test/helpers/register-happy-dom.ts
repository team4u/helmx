/**
 * Side-effect module that registers happy-dom idempotently on first import.
 * Place as the very first static import in DOM tests so happy-dom globals exist
 * before react-dom/client or Radix UI modules initialize.
 */
import { ensureHappyDom } from './dom-harness.js'

ensureHappyDom()
