import { AlertCircle, CheckCircle2, CloudOff, LoaderCircle, SearchX } from 'lucide-react'
import type { ReactNode } from 'react'

export type StateMessageKind = 'loading' | 'empty' | 'error' | 'success' | 'offline'

export function StateMessage({
  kind,
  title,
  description,
  action,
  compact = false,
}: {
  kind: StateMessageKind
  title: string
  description?: string
  action?: ReactNode
  compact?: boolean
}) {
  const Icon = {
    loading: LoaderCircle,
    empty: SearchX,
    error: AlertCircle,
    success: CheckCircle2,
    offline: CloudOff,
  }[kind]
  const role = kind === 'error' ? 'alert' : 'status'

  return (
    <div className={`ui-state ui-state-${kind} ${compact ? 'ui-state-compact' : ''}`} role={role}>
      <Icon
        className={kind === 'loading' ? 'spin' : ''}
        size={compact ? 'var(--icon-control)' : 'var(--icon-section)'}
      />
      <div>
        <strong>{title}</strong>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="ui-state-action">{action}</div>}
    </div>
  )
}
