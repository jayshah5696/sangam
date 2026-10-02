import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Inbox } from 'lucide-react'
import { api, type DocumentSummary } from '../../api'
import { INBOX_FOLDER } from '../../capture'
import { StateMessage } from '../ui/StateMessage'

const VISIBLE = 6

type InboxState = { label: string; attention: boolean }

function inboxState(document: DocumentSummary): InboxState {
  switch (document.pdf_extraction_status) {
    case 'pending':
    case 'processing':
      return { label: 'Extracting text', attention: false }
    case 'failed':
      return { label: 'Needs attention', attention: true }
    default:
      return {
        label:
          document.content_type === 'application/pdf'
            ? 'PDF'
            : document.content_type === 'text/html'
              ? 'HTML'
              : 'Note',
        attention: false,
      }
  }
}

/** Material captured but not yet organized: everything still in the Inbox folder. */
export function InboxSection({ onCapture }: { onCapture: () => void }) {
  const queryClient = useQueryClient()
  // Shares the complete document index that the editor already keeps fresh.
  const documents = useQuery({
    queryKey: ['documents', 'all'],
    queryFn: api.listDocuments,
    refetchInterval: (query) =>
      query.state.data?.some(
        (document) =>
          document.path?.startsWith(`${INBOX_FOLDER}/`) &&
          (document.pdf_extraction_status === 'pending' || document.pdf_extraction_status === 'processing'),
      )
        ? 3_000
        : false,
  })
  const retry = useMutation({
    mutationFn: (documentId: string) => api.retryPdfExtraction(documentId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['documents'] }),
  })
  const items = (documents.data ?? [])
    .filter((document) => document.path?.startsWith(`${INBOX_FOLDER}/`))
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
  return (
    <section className="home-inbox" aria-labelledby="home-inbox-title">
      <header>
        <h2 id="home-inbox-title">
          <Inbox size="var(--icon-inline)" aria-hidden="true" /> Inbox
          {items.length > 0 && <small>{items.length}</small>}
        </h2>
        <button type="button" className="secondary-action" onClick={onCapture}>
          Capture
        </button>
      </header>
      {documents.isError && (
        <StateMessage
          compact
          kind="error"
          title="Could not load the Inbox"
          action={<button onClick={() => void documents.refetch()}>Retry</button>}
        />
      )}
      {retry.isError && (
        <StateMessage
          compact
          kind="error"
          title="Extraction could not restart"
          description={retry.error.message}
        />
      )}
      {documents.isSuccess && items.length === 0 && (
        <p className="small-muted">Nothing waiting. Captured material lands here until you move it.</p>
      )}
      {items.length > 0 && (
        <ul>
          {items.slice(0, VISIBLE).map((document) => {
            const state = inboxState(document)
            return (
              <li key={document.document_id} className={state.attention ? 'attention' : undefined}>
                <Link to="/documents/$documentId" params={{ documentId: document.document_id }}>
                  {document.title}
                </Link>
                <span className="scope-badge">{state.label}</span>
                {state.attention && (
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={retry.isPending}
                    title={document.pdf_extraction_error ?? undefined}
                    onClick={() => retry.mutate(document.document_id)}
                  >
                    Retry extraction
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {items.length > VISIBLE && (
        <p className="small-muted">
          {items.length - VISIBLE} more in the <code>{INBOX_FOLDER}/</code> folder.
        </p>
      )}
    </section>
  )
}
