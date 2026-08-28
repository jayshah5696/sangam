import { lazy, Suspense } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, MessageSquareText } from 'lucide-react'
import { z } from 'zod'
import { api, type Document } from '../api'
import { StateMessage } from '../components/ui/StateMessage'

const ChatPanel = lazy(() =>
  import('../components/ChatPanel').then((module) => ({ default: module.ChatPanel })),
)

const chatSearchSchema = z.object({
  document: z.string().max(200).optional(),
  revision: z.string().max(200).optional(),
  returnTo: z.string().max(500).optional(),
})

export const Route = createFileRoute('/chat')({
  validateSearch: chatSearchSchema,
  component: WorkspaceChat,
})

function safeReturnPath(value: string | undefined) {
  return value?.startsWith('/documents/') && !value.startsWith('//') ? value : '/'
}

function WorkspaceChat() {
  const search = Route.useSearch()
  const location = useLocation()
  const selectedText = search.document ? (location.state.sangamChatContext?.selectedText ?? '') : ''
  const pdfPageNumber = search.document ? location.state.sangamChatContext?.pdfPageNumber : undefined
  const annotationId = search.document ? location.state.sangamChatContext?.annotationId : undefined
  const navigate = useNavigate({ from: '/chat' })
  const queryClient = useQueryClient()
  const documentQuery = useQuery({
    queryKey: ['document', search.document],
    queryFn: () => api.getDocument(search.document!),
    enabled: Boolean(search.document),
  })
  const document = documentQuery.data ?? null
  const contextIsCurrent = !document || !search.revision || document.current_revision_id === search.revision
  const clearContext = () =>
    navigate({
      search: search.returnTo ? { returnTo: search.returnTo } : {},
      state: {},
      replace: true,
    })
  const updateDocument = (nextDocument: Document) => {
    queryClient.setQueryData(['document', nextDocument.document_id], nextDocument)
    void queryClient.invalidateQueries({ queryKey: ['documents'] })
    void navigate({
      search: (current) => ({ ...current, revision: nextDocument.current_revision_id }),
      replace: true,
    })
  }

  return (
    <section className="workspace-chat-page">
      <header className="workspace-chat-header">
        <button
          type="button"
          className="icon-button"
          aria-label={search.returnTo ? 'Return to document' : 'Return to workspace'}
          title={search.returnTo ? 'Return to document' : 'Return to workspace'}
          onClick={() => void navigate({ href: safeReturnPath(search.returnTo) })}
        >
          <ArrowLeft size="var(--icon-control)" />
        </button>
        <div>
          <h1>Workspace chat</h1>
          <p>
            {document
              ? `Ask about ${document.title} without covering the document workspace.`
              : 'Search, compare, and create across your notes.'}
          </p>
        </div>
        <MessageSquareText size="var(--icon-page)" />
      </header>
      <div className="workspace-chat-surface">
        {documentQuery.isLoading ? (
          <StateMessage kind="loading" title="Attaching document context" />
        ) : documentQuery.isError || (search.document && !document) ? (
          <StateMessage
            kind="error"
            title="Document context could not be loaded"
            description="The conversation is paused so a prompt cannot be sent against the wrong document."
            action={
              <button type="button" className="secondary-action" onClick={() => void clearContext()}>
                Continue without document
              </button>
            }
          />
        ) : !contextIsCurrent ? (
          <StateMessage
            kind="error"
            title="The document changed before chat opened"
            description="Return to the document and attach its current revision before sending a prompt."
            action={
              <button
                type="button"
                className="secondary-action"
                onClick={() => void navigate({ href: safeReturnPath(search.returnTo) })}
              >
                Return to document
              </button>
            }
          />
        ) : (
          <Suspense fallback={<StateMessage kind="loading" title="Preparing workspace chat" />}>
            <ChatPanel
              document={document}
              selectedText={selectedText}
              pdfPageNumber={document?.content_type === 'application/pdf' ? pdfPageNumber : null}
              annotationId={document?.content_type === 'application/pdf' ? annotationId : null}
              onClearContext={document ? () => void clearContext() : undefined}
              onDocumentUpdated={document ? updateDocument : undefined}
            />
          </Suspense>
        )}
      </div>
    </section>
  )
}
