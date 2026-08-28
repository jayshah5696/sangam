import { z } from 'zod'
import type { JsonScalar } from '../api'

export type DocumentContentType = 'text/markdown' | 'text/html'

export type CreateConfirmationRequest = {
  title: string
  content: string
  contentType: DocumentContentType
}

export type CreateConfirmationInput = Record<string, JsonScalar>

const FORMAT_LABEL = {
  'text/markdown': 'Markdown',
  'text/html': 'HTML',
} satisfies Record<DocumentContentType, string>

const createConfirmationSchema = z.object({
  title: z.string().trim().min(1).max(240),
  content: z.string().max(2_000_000),
  content_type: z.enum(['text/markdown', 'text/html']).optional().default('text/markdown'),
})

export function parseCreateConfirmation(
  params: CreateConfirmationInput | null | undefined,
): CreateConfirmationRequest | null {
  const result = createConfirmationSchema.safeParse(params)
  if (!result.success) return null
  return {
    title: result.data.title,
    content: result.data.content,
    contentType: result.data.content_type,
  }
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
