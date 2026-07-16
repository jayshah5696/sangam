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
  role?: 'menu' | 'dialog'
}

export function ActionMenu({ label, icon, children, className = '', role = 'menu' }: ActionMenuProps) {
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0, visible: false })
  const dismiss = useCallback(() => setOpen(false), [])

  const close = (restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }

  useLayoutEffect(() => {
    if (!open) return
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
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) close(false)
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }
    const dismiss = () => close(false)
    place()
    requestAnimationFrame(() => {
      place()
      menuRef.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus()
    })
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', escape)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('keydown', escape)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [open])

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])]
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
        aria-haspopup={role}
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
            role={role}
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
