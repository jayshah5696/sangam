import { FolderKanban } from 'lucide-react'
import type { ChatEffect } from '../api'
import { projectChangeDetail, projectChangeTitle, type ProjectChange } from '../chatEffectCopy'
import { StateMessage } from './ui/StateMessage'

/** Review one exact project change before chat is allowed to make it. */
export function ChatProjectConfirmation({
  effect,
  change,
  pending,
  error,
  onApprove,
  onCancel,
}: {
  effect: ChatEffect
  change: ProjectChange
  pending: boolean
  error: boolean
  onApprove: () => void
  onCancel: () => void
}) {
  const expires = new Date(effect.expires_at).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })
  return (
    <section
      className="chat-effect-confirmation"
      role="alertdialog"
      aria-labelledby="project-change-title"
      aria-describedby="project-change-detail"
    >
      <header>
        <p className="eyebrow">Project change</p>
        <h3 id="project-change-title">
          <FolderKanban size="var(--icon-inline)" /> {projectChangeTitle(change)}
        </h3>
        <p id="project-change-detail">
          {projectChangeDetail(change)} · requested by {effect.requested_by} · expires at {expires}
        </p>
      </header>
      {error && (
        <StateMessage
          compact
          kind="error"
          title="The decision could not be completed"
          description="Refresh the review before trying again."
        />
      )}
      <div className="chat-effect-actions">
        <button type="button" className="secondary-action" disabled={pending} onClick={onCancel}>
          Cancel task
        </button>
        <button type="button" className="primary-button" disabled={pending} onClick={onApprove}>
          {pending ? 'Applying…' : 'Approve project change'}
        </button>
      </div>
    </section>
  )
}
