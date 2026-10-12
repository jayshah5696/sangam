import {
  chatMemoryPreviewSchema,
  chatProfileUpdateSchema,
  taskCorrectionPreviewSchema,
  type ChatEffect,
} from '../api'
import type { EffectReview } from '../chatEffectCopy'
import { StateMessage } from './ui/StateMessage'

/** Review one exact change to one resource before chat is allowed to make it. */
export function ChatEffectConfirmation({
  effect,
  review,
  pending,
  error,
  onApprove,
  onCancel,
}: {
  effect: ChatEffect
  review: EffectReview
  pending: boolean
  error: boolean
  onApprove: () => void
  onCancel: () => void
}) {
  const expires = new Date(effect.expires_at).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })
  const profile =
    effect.capability_id === 'update_chat_profile' ? chatProfileUpdateSchema.safeParse(effect.preview) : null
  const memory =
    effect.capability_id === 'update_chat_memory' ? chatMemoryPreviewSchema.safeParse(effect.preview) : null
  const task =
    effect.capability_id === 'correct_task_state'
      ? taskCorrectionPreviewSchema.safeParse(effect.preview)
      : null
  return (
    <section
      className="chat-effect-confirmation"
      role="alertdialog"
      aria-labelledby={`review-title-${effect.effect_id}`}
      aria-describedby={`review-detail-${effect.effect_id}`}
    >
      <header>
        <p className="eyebrow">{review.eyebrow}</p>
        <h3 id={`review-title-${effect.effect_id}`}>{review.title}</h3>
        <p id={`review-detail-${effect.effect_id}`}>
          {review.detail} · requested by {effect.requested_by} · expires at {expires}
        </p>
      </header>
      {profile?.success && (
        <pre className="instruction-content" aria-label="Instructions to save">
          {profile.data.content || '(Clear saved instructions)'}
        </pre>
      )}
      {task?.success && (
        <pre className="instruction-content" aria-label="Task correction to approve">
          {`Current: ${task.data.before.notes.find((note) => note.key === task.data.key)?.text ?? ''}\n`}
          {`Correction: ${task.data.text || '(Dismiss this field)'}\n`}
          This changes task context only. It does not approve or resume other effects.
        </pre>
      )}
      {memory?.success && (
        <pre className="instruction-content" aria-label="Fact change to approve">
          {memory.data.previous_content ? `Current fact: ${memory.data.previous_content}\n` : ''}
          {memory.data.action === 'forget'
            ? 'Stop recalling this saved fact. The original transcript and past run evidence remain.'
            : memory.data.content}
          {memory.data.source_thread_id
            ? `\nSource thread: ${memory.data.source_thread_id}`
            : '\nSource: direct edit'}
          {memory.data.source_item_id ? `\nSource message: ${memory.data.source_item_id}` : ''}
        </pre>
      )}
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
          {pending ? 'Applying…' : review.approveLabel}
        </button>
      </div>
    </section>
  )
}
