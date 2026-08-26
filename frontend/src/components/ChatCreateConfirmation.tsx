const SUPPORTED_CONTENT_TYPES = ['text/markdown', 'text/html'] as const
type DocumentContentType = (typeof SUPPORTED_CONTENT_TYPES)[number]

export type CreateConfirmationRequest = {
  title: string
  content: string
  contentType: DocumentContentType
}

const FORMAT_LABEL: Record<DocumentContentType, string> = {
  'text/markdown': 'Markdown',
  'text/html': 'HTML',
}

export function parseCreateConfirmation(params: Record<string, unknown>): CreateConfirmationRequest | null {
  const title = typeof params.title === 'string' ? params.title.trim() : ''
  if (typeof params.content !== 'string') return null
  const content = params.content
  if (!title || title.length > 240 || content.length > 2_000_000) return null
  // Fall back to text/markdown for v1 effects that lack content_type
  const rawType = typeof params.content_type === 'string' ? params.content_type : 'text/markdown'
  if (!SUPPORTED_CONTENT_TYPES.includes(rawType as DocumentContentType)) return null
  return { title, content, contentType: rawType as DocumentContentType }
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
  const formatName = FORMAT_LABEL[request.contentType]
  return (
    <section className="chat-effect-confirmation" role="alertdialog" aria-labelledby="create-confirm-title">
      <div>
        <p className="eyebrow">Workspace write</p>
        <strong id="create-confirm-title">
          Create {formatName} document "{request.title}"?
        </strong>
        <span>
          The assistant prepared a new {formatName} document with {request.content.length.toLocaleString()}{' '}
          characters. Review the complete source before approval.
        </span>
        <pre className="chat-create-preview" aria-label="Document content to create">
          <code>{request.content}</code>
        </pre>
        <small>No document is created until you approve the content shown above.</small>
        {error && <p className="error-text">Creation failed. Retry or cancel.</p>}
      </div>
      <div className="chat-effect-actions">
        <button type="button" className="primary-button" disabled={pending} onClick={onApprove}>
          {pending ? 'Creating…' : `Approve ${formatName} document creation`}
        </button>
        <button type="button" className="secondary-action" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  )
}
