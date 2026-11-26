/**
 * Internal React context signaling that a descendant SearchBox sits inside a
 * ScreenToolbar so primary/plugin screens get `Esc` clear/blur automatically
 * without adding new public SDK exports.
 */
import { createContext } from 'react'

export const ScreenToolbarContext = createContext(false)
