import { lazy, Suspense } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, MessageSquareText } from 'lucide-react'
import { z } from 'zod'
import { api, type Document } from '../api'
import { adoptDocumentInCache } from '../documentCache'
import { StateMessage } from '../components/ui/StateMessage'

const ChatPanel = lazy(() =>
  import('../components/ChatPanel').then((module) => ({ default: module.ChatPanel })),
)

const chatSearchSchema = z.object({
  document: z.string().max(200).optional(),
  revision: z.string().max(200).optional(),
  returnTo: z.string().max(500).optional(),
  prompt: z.string().max(2000).optional(),
  thread: z.string().max(200).optional(),
  proposal: z.string().max(200).optional(),
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
  const initialPrompt =
    z.string().max(2_020_000).optional().parse(location.state.sangamChatInitialPrompt) ?? search.prompt
  const selectedText = search.document ? (location.state.sangamChatContext?.selectedText ?? '') : ''
  const pdfPageNumber = search.document ? location.state.sangamChatContext?.pdfPageNumber : undefined
  const annotationId = search.document ? location.state.sangamChatContext?.annotationId : undefined
  const navigate = useNavigate({ from: '/chat' })
  const queryClient = useQueryClient()
  const documentQuery = useQuery({
    queryKey: ['document', search.document],
    queryFn: () => api.getDocument(search.document!),
    enabled: Boolean(search.document),
    refetchOnMount: 'always',
  })
  const document = documentQuery.data ?? null
  const historyQuery = useQuery({
    queryKey: ['revision', search.document, search.revision],
    queryFn: () => api.revision(search.document!, search.revision!),
    enabled: Boolean(document && search.revision && document.current_revision_id !== search.revision),
  })
  const historical = historyQuery.data
  const contextDocument =
    document && historical
      ? {
          ...document,
          content: historical.content,
          current_revision_id: historical.revision_id,
          content_hash: historical.content_hash,
          size_bytes: historical.size_bytes,
        }
      : document
  const contextIsCurrent =
    !document || !search.revision || document.current_revision_id === search.revision || Boolean(historical)
  const clearContext = () =>
    navigate({
      search: {
        returnTo: search.returnTo,
        prompt: search.prompt,
        thread: search.thread,
        proposal: search.proposal,
      },
      state: { sangamChatInitialPrompt: initialPrompt },
      replace: true,
    })
  const updateDocument = (nextDocument: Document) => {
    adoptDocumentInCache(queryClient, nextDocument)
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
        {documentQuery.isLoading ||
        historyQuery.isLoading ||
        (Boolean(search.document) && !documentQuery.isFetchedAfterMount) ? (
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
              key={`${search.thread ?? ''}:${search.proposal ?? ''}`}
              initialPrompt={initialPrompt}
              initialThreadId={search.thread}
              document={contextDocument}
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
