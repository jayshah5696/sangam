export type CreateConfirmationRequest = {
  title: string
  content: string
  contentType: 'text/markdown'
}

export function parseCreateConfirmation(params: Record<string, unknown>): CreateConfirmationRequest | null {
  const title = typeof params.title === 'string' ? params.title.trim() : ''
  if (typeof params.content !== 'string') return null
  const content = params.content
  if (!title || title.length > 240 || content.length > 2_000_000) return null
  return { title, content, contentType: 'text/markdown' }
}

export function ChatCreateConfirmation({
  request,
  pending,
  error,
  onApprove,
  onCancel,
}: {
  request: CreateConfirmationRequest
  pending: boolean
  error: boolean
  onApprove: () => void
  onCancel: () => void
}) {
  return (
    <section className="chat-effect-confirmation" role="alertdialog" aria-labelledby="create-confirm-title">
      <div>
        <p className="eyebrow">Workspace write</p>
        <strong id="create-confirm-title">Create “{request.title}”?</strong>
        <span>
          The assistant prepared a new Markdown document with {request.content.length.toLocaleString()}{' '}
          characters.
        </span>
        <small>No document is created until you approve this exact content.</small>
        {error && <p className="error-text">Creation failed. Retry or cancel.</p>}
      </div>
      <div className="chat-effect-actions">
        <button type="button" className="primary-button" disabled={pending} onClick={onApprove}>
          {pending ? 'Creating…' : 'Approve document creation'}
        </button>
        <button type="button" className="secondary-action" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  )
}
