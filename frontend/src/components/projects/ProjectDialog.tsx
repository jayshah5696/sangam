import type { ReactNode } from 'react'
import { ModalDialog } from '../ui/ModalDialog'

export function ProjectDialog({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <ModalDialog title={title} className="project-modal-dialog" onClose={onClose}>
      {children}
    </ModalDialog>
  )
}
