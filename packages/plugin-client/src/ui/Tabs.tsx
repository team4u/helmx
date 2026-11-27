import React, { createContext, useContext, useEffect, useRef, useState, forwardRef } from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import type {
  TabsVariant,
  TabsSize,
  SegmentedControlItem,
  SegmentedControlProps,
  TabsContextValue,
} from './tabs-model.js'

export type {
  TabsVariant,
  TabsSize,
  SegmentedControlItem,
  SegmentedControlProps,
  TabsContextValue,
}

type ResolvedTabsVariant = 'underline' | 'segmented' | 'pills'

const ROOT_VARIANT_CLASS: Record<TabsVariant, string> = {
  underline: 'helmx-tabs-underline',
  default: 'helmx-tabs-underline',
  segmented: 'helmx-tabs-segmented',
  pills: 'helmx-tabs-pills',
}

const ROOT_SIZE_CLASS: Record<TabsSize, string> = {
  sm: 'helmx-tabs-sm',
  md: 'helmx-tabs-md',
}

const LIST_VARIANT_CLASS: Record<ResolvedTabsVariant, string> = {
  underline: 'tabs-bar',
  segmented: 'segmented-control',
  pills: 'tabs-pills',
}

const TRIGGER_VARIANT_CLASS: Record<ResolvedTabsVariant, string> = {
  underline: 'tab-btn',
  segmented: 'segmented-control-btn',
  pills: 'tabs-pill',
}

const TRIGGER_ACTIVE_CLASS: Record<ResolvedTabsVariant, string> = {
  underline: 'tab-btn-active',
  segmented: 'is-active',
  pills: 'is-active',
}

function hasClassToken(className: string, token: string): boolean {
  if (className === '') return false
  return className.split(/\s+/).includes(token)
}

function resolveListVariant(variant: TabsVariant, className: string): ResolvedTabsVariant {
  if (variant === 'segmented' || hasClassToken(className, 'segmented-control')) return 'segmented'
  if (variant === 'pills' || hasClassToken(className, 'tabs-pills')) return 'pills'
  return 'underline'
}

function resolveTriggerVariant(variant: TabsVariant, className: string): ResolvedTabsVariant {
  if (variant === 'segmented' || hasClassToken(className, 'segmented-control-btn')) return 'segmented'
  if (variant === 'pills' || hasClassToken(className, 'tabs-pill')) return 'pills'
  return 'underline'
}

const TabsContext = createContext<TabsContextValue>({
  variant: 'underline',
})

const TabsListContext = createContext<{ variant: ResolvedTabsVariant }>({
  variant: 'underline',
})

export interface TabsProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root> {
  variant?: TabsVariant
  size?: TabsSize
}

const TabsRoot = forwardRef<React.ComponentRef<typeof TabsPrimitive.Root>, TabsProps>(
  function Tabs({ variant = 'underline', size, value, defaultValue, onValueChange, className, ...props }, ref) {
    const isControlled = value !== undefined
    const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue ?? '')
    const activeValue = isControlled ? value : uncontrolledValue
    const activeValueRef = useRef(activeValue)
    activeValueRef.current = activeValue
    // Coalesce duplicate activation callbacks within the same pointer/keyboard
    // turn (e.g. Radix mousedown -> focus -> click) before React re-renders.
    const pendingEmissionRef = useRef<string | undefined>(undefined)

    const handleValueChange = (newVal: string) => {
      if (newVal === activeValueRef.current || newVal === pendingEmissionRef.current) {
        return
      }
      pendingEmissionRef.current = newVal
      queueMicrotask(() => {
        if (pendingEmissionRef.current === newVal) {
          pendingEmissionRef.current = undefined
        }
      })
      if (!isControlled) {
        setUncontrolledValue(newVal)
      }
      onValueChange?.(newVal)
    }

    const contextValue: TabsContextValue = {
      value: activeValue,
      onValueChange: handleValueChange,
      variant,
      size,
    }

    const rootClass = [
      'helmx-tabs',
      ROOT_VARIANT_CLASS[variant],
      size ? ROOT_SIZE_CLASS[size] : undefined,
      className,
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <TabsContext.Provider value={contextValue}>
        <TabsPrimitive.Root
          ref={ref}
          value={activeValue}
          onValueChange={handleValueChange}
          className={rootClass}
          {...props}
        />
      </TabsContext.Provider>
    )
  },
)

export interface TabsListProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> {
  variant?: TabsVariant
  size?: TabsSize
}

export const TabsList = forwardRef<React.ComponentRef<typeof TabsPrimitive.List>, TabsListProps>(
  function TabsList({ variant: variantProp, size: _size, className = '', ...props }, ref) {
    const context = useContext(TabsContext)
    const variant = variantProp ?? context.variant
    const resolvedVariant = resolveListVariant(variant, className)

    const defaultBaseClass = LIST_VARIANT_CLASS[resolvedVariant]
    const listClass = hasClassToken(className, defaultBaseClass)
      ? className
      : [defaultBaseClass, className].filter(Boolean).join(' ')

    return (
      <TabsListContext.Provider value={{ variant: resolvedVariant }}>
        <TabsPrimitive.List ref={ref} className={listClass} {...props} />
      </TabsListContext.Provider>
    )
  },
)

export interface TabsTriggerProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> {
  variant?: TabsVariant
}

export const TabsTrigger = forwardRef<React.ComponentRef<typeof TabsPrimitive.Trigger>, TabsTriggerProps>(
  function TabsTrigger(
    { variant: variantProp, className = '', value, disabled, onClick, onMouseDown, onKeyDown, onBlur, ...props },
    ref,
  ) {
    const rootContext = useContext(TabsContext)
    const listContext = useContext(TabsListContext)
    const variant = variantProp ?? listContext.variant ?? rootContext.variant
    const resolvedVariant = resolveTriggerVariant(variant, className)

    const isActive = rootContext.value !== undefined && rootContext.value === value
    const defaultBaseClass = TRIGGER_VARIANT_CLASS[resolvedVariant]
    const activeToken = TRIGGER_ACTIVE_CLASS[resolvedVariant]

    const triggerClass = [
      hasClassToken(className, defaultBaseClass) ? undefined : defaultBaseClass,
      isActive && !hasClassToken(className, activeToken) ? activeToken : undefined,
      className || undefined,
    ]
      .filter(Boolean)
      .join(' ')

    const suppressNextClickRef = useRef(false)

    useEffect(() => {
      if (!isActive) {
        suppressNextClickRef.current = false
      }
    }, [rootContext.value, isActive])

    const handleMouseDown = (e: React.MouseEvent<HTMLButtonElement>) => {
      suppressNextClickRef.current = true
      onMouseDown?.(e)
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.target === e.currentTarget && (e.key === ' ' || e.key === 'Enter')) {
        suppressNextClickRef.current = true
      }
      onKeyDown?.(e)
    }

    const handleBlur = (e: React.FocusEvent<HTMLButtonElement>) => {
      suppressNextClickRef.current = false
      onBlur?.(e)
    }

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e)
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false
        return
      }
      if (e.defaultPrevented || e.ctrlKey || e.button !== 0) {
        return
      }
      // Fallback for pure programmatic `.click()` (e.g. happy-dom tests or assistive
      // tech invoking click without a preceding pointer mousedown or keyboard keydown).
      if (!disabled && rootContext.onValueChange && rootContext.value !== value) {
        rootContext.onValueChange(value)
      }
    }

    return (
      <TabsPrimitive.Trigger
        ref={ref}
        value={value}
        disabled={disabled}
        className={triggerClass}
        onMouseDown={handleMouseDown}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        onClick={handleClick}
        {...props}
      />
    )
  },
)

export interface TabsContentProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content> {}

export const TabsContent = forwardRef<React.ComponentRef<typeof TabsPrimitive.Content>, TabsContentProps>(
  function TabsContent({ className = '', ...props }, ref) {
    const contentClass = ['tabs-content', className].filter(Boolean).join(' ')
    return <TabsPrimitive.Content ref={ref} className={contentClass} {...props} />
  },
)

export interface TabCountProps extends React.ComponentPropsWithoutRef<'span'> {}

/** Lightweight inline tabular-nums count rendered inside tab triggers (`TabsTrigger` / `SegmentedControl`). */
export const TabCount = forwardRef<HTMLSpanElement, TabCountProps>(function TabCount(
  { className = '', ...props },
  ref,
) {
  const countClass = ['helmx-tab-count', 'tabular-nums', className].filter(Boolean).join(' ')
  return <span ref={ref} className={countClass} {...props} />
})

export type TabsCompoundComponent = typeof TabsRoot & {
  List: typeof TabsList
  Trigger: typeof TabsTrigger
  Content: typeof TabsContent
  Count: typeof TabCount
}

export const Tabs: TabsCompoundComponent = Object.assign(TabsRoot, {
  List: TabsList,
  Trigger: TabsTrigger,
  Content: TabsContent,
  Count: TabCount,
})

export function SegmentedControl<T extends string = string>({
  value,
  defaultValue,
  onValueChange,
  items,
  size,
  disabled = false,
  className = '',
  rootClassName = '',
  style,
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <Tabs
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange as (val: string) => void}
      variant="segmented"
      size={size}
      className={rootClassName}
      style={style}
    >
      <TabsList className={['segmented-control', className].filter(Boolean).join(' ')} aria-label={ariaLabel}>
        {items.map((item) => (
          <TabsTrigger
            key={item.value}
            value={item.value}
            disabled={disabled || item.disabled}
            title={item.title}
            aria-label={item.ariaLabel}
            className={item.className}
            onClick={item.onClick}
          >
            {item.icon}
            {item.label}
            {item.badge}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
