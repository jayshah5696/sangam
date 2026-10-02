import type { ChatEffect } from '../api'
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
