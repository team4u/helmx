import type { ReactNode } from 'react'

export interface SelectOption<T extends string = string> {
  value: T
  label: ReactNode
  description?: string
  icon?: string
  disabled?: boolean
  meta?: ReactNode
}

export interface SelectChangeEvent<T extends string = string> {
  target: {
    value: T
    name?: string
  }
}

export interface MultiSelectChangeEvent<T extends string = string> {
  target: {
    value: T[]
    name?: string
  }
}
