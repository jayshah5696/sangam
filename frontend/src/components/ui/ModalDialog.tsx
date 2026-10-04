import { useEffect, useId, useRef, type ReactNode } from 'react'

export interface ModalDialogProps {
  title?: string
  ariaLabel?: string
  ariaLabelledBy?: string
  className?: string
  onClose: () => void
  children: ReactNode
}

/**
 * Shared accessible modal dialog anatomy across Sangam.
 * Enforces native <dialog> semantics, showModal overlay, focus trapping,
 * focus restoration to trigger, Esc cancellation, and backdrop click dismiss.
 */
export function ModalDialog({
  title,
  ariaLabel,
  ariaLabelledBy,
  className = '',
  onClose,
  children,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const generatedId = useId()
  const headingId = ariaLabelledBy || (title ? generatedId : undefined)

  useEffect(() => {
    const active = document.activeElement
    const trigger = active instanceof HTMLElement ? active : null
    const dialog = dialogRef.current
    if (dialog && !dialog.open) {
      if (dialog.showModal) {
        dialog.showModal()
      } else {
        dialog.setAttribute('open', '')
      }
    }
    const hasAutofocus = dialog?.querySelector<HTMLElement>('[autofocus], [data-autofocus]')
    if (hasAutofocus) {
      hasAutofocus.focus()
    } else {
      const firstFocusable = dialog?.querySelector<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
      )
      firstFocusable?.focus()
    }

    const handleNativeKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    dialog?.addEventListener('keydown', handleNativeKeyDown)

    return () => {
      dialog?.removeEventListener('keydown', handleNativeKeyDown)
      if (dialog && dialog.open) {
        if (dialog.close) {
          dialog.close()
        } else {
          dialog.removeAttribute('open')
        }
      }
      if (trigger && trigger.isConnected) {
        trigger.focus()
      }
    }
  }, [onClose])

  return (
    <dialog
      ref={dialogRef}
      className={`shared-dialog ${className}`.trim()}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
          return
        }
        if (event.key !== 'Tab') return
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
          ),
        ]
        if (controls.length === 0) return
        const first = controls[0]
        const last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }}
    >
      {title && <h2 id={headingId}>{title}</h2>}
      {children}
    </dialog>
  )
}
