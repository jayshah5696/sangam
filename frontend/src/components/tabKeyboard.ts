import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/** Implements the WAI-ARIA automatic-activation keyboard model for horizontal tabs. */
export function activateTabFromKeyboard(event: ReactKeyboardEvent<HTMLButtonElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return

  const tablist = event.currentTarget.closest('[role="tablist"]')
  const tabs = Array.from(tablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []).filter(
    (tab) => !tab.disabled,
  )
  const currentIndex = tabs.indexOf(event.currentTarget)
  if (currentIndex < 0 || tabs.length === 0) return

  event.preventDefault()
  const nextIndex =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  const nextTab = tabs[nextIndex]
  nextTab?.focus()
  nextTab?.click()
}
