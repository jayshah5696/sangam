import {
  useId,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

type ActionMenuProps = {
  label: string
  icon: ReactNode
  children: (close: () => void) => ReactNode
  className?: string
}

export function ActionMenu({ label, icon, children, className = '' }: ActionMenuProps) {
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0, visible: false })
  const dismiss = useCallback(() => {
    setOpen(false)
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    const closeMenu = (restoreFocus = true) => {
      setOpen(false)
      if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus())
    }
    const place = () => {
      const trigger = triggerRef.current?.getBoundingClientRect()
      const menu = menuRef.current?.getBoundingClientRect()
      if (!trigger || !menu) return
      const gap = 5
      const edge = 8
      const below = trigger.bottom + gap
      const top =
        below + menu.height <= window.innerHeight - edge
          ? below
          : Math.max(edge, trigger.top - menu.height - gap)
      const left = Math.min(window.innerWidth - menu.width - edge, Math.max(edge, trigger.right - menu.width))
      setPosition({ top, left, visible: true })
    }
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) closeMenu(false)
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu(true)
      }
    }
    const dismissAll = () => closeMenu(false)
    place()
    requestAnimationFrame(() => {
      place()
      menuRef.current
        ?.querySelector<HTMLElement>('button:not(:disabled), [role="menuitem"]:not(:disabled)')
        ?.focus()
    })
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', escape)
    window.addEventListener('resize', dismissAll)
    window.addEventListener('scroll', dismissAll, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('keydown', escape)
      window.removeEventListener('resize', dismissAll)
      window.removeEventListener('scroll', dismissAll, true)
    }
  }, [open])

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [role="menuitem"]:not(:disabled)',
      ) ?? []),
    ]
    if (items.length === 0) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (current + 1 + items.length) % items.length
            : (current - 1 + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`action-menu-trigger ${className}`.trim()}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={label}
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            className="action-menu-popover"
            style={{
              top: position.top,
              left: position.left,
              visibility: position.visible ? 'visible' : 'hidden',
            }}
            onKeyDown={moveFocus}
          >
            {children(dismiss)}
          </div>,
          document.body,
        )}
    </>
  )
}

type ActionDialogProps = {
  label: string
  icon: ReactNode
  children: (close: () => void) => ReactNode
  className?: string
}

export function ActionDialog({ label, icon, children, className = '' }: ActionDialogProps) {
  const dialogId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0, visible: false })
  const dismiss = useCallback(() => {
    setOpen(false)
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    const closeDialog = (restoreFocus = true) => {
      setOpen(false)
      if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus())
    }
    const place = () => {
      const trigger = triggerRef.current?.getBoundingClientRect()
      const dialog = dialogRef.current?.getBoundingClientRect()
      if (!trigger || !dialog) return
      const gap = 5
      const edge = 8
      const below = trigger.bottom + gap
      const top =
        below + dialog.height <= window.innerHeight - edge
          ? below
          : Math.max(edge, trigger.top - dialog.height - gap)
      const left = Math.min(
        window.innerWidth - dialog.width - edge,
        Math.max(edge, trigger.right - dialog.width),
      )
      setPosition({ top, left, visible: true })
    }
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!dialogRef.current?.contains(target) && !triggerRef.current?.contains(target)) closeDialog(false)
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeDialog(true)
        return
      }
      if (event.key === 'Tab') {
        const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('*') ?? [])].filter((el) => {
          if (el.hasAttribute('disabled')) return false
          const tag = el.tagName.toLowerCase()
          if (['button', 'input', 'select', 'textarea'].includes(tag)) return true
          const tabIndex = el.getAttribute('tabindex')
          return tabIndex !== null && tabIndex !== '-1'
        })
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (
          event.shiftKey &&
          (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))
        ) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    const dismissAll = () => closeDialog(false)
    place()
    dialogRef.current
      ?.querySelector<HTMLElement>(
        'input:not(:disabled), button:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
      )
      ?.focus()
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', dismissAll)
    window.addEventListener('scroll', dismissAll, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', dismissAll)
      window.removeEventListener('scroll', dismissAll, true)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`action-menu-trigger ${className}`.trim()}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        title={label}
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
      </button>
      {open &&
        createPortal(
          <div
            ref={dialogRef}
            id={dialogId}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            className="action-menu-popover action-dialog-popover"
            style={{
              top: position.top,
              left: position.left,
              visibility: position.visible ? 'visible' : 'hidden',
            }}
          >
            {children(dismiss)}
          </div>,
          document.body,
        )}
    </>
  )
}

type ActionMenuItemProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  onSelect: () => void
}

export function ActionMenuItem({ onSelect, children, ...props }: ActionMenuItemProps) {
  return (
    <button type="button" role="menuitem" onClick={onSelect} {...props}>
      {children}
    </button>
  )
}
