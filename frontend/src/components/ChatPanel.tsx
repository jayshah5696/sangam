import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ChatKit, useChatKit } from '@openai/chatkit-react'
import { api, type ChatProposal, type Document, type IssuedPublication, type Publication } from '../api'
import {
  announceCitationNavigation,
  citationHref,
  citationTargetFromData,
  type CitationTarget,
} from '../citationNavigation'
import { useTheme } from '../theme'
import { OneTimeSecret } from './OneTimeSecret'
import { RevisionMergeView } from './RevisionMergeView'

const SELECTION_LIMIT = 20_000
const CHATKIT_SCRIPT_SRC = 'https://cdn.platform.openai.com/deployments/chatkit/chatkit.js'

// One workspace-scoped chat thread persists across document tabs; the active
// document is passed as live context rather than switching threads per tab.
const THREAD_STORAGE_KEY = 'sangam.chat-thread.workspace'

export type PublishConfirmationRequest = {
  documentId: string
  documentTitle: string
  slug: string
  accessPolicy: Publication['access_policy']
}

export function ChatPanel({
  document,
  selectedText,
  onDocumentUpdated,
}: {
  document: Document
  selectedText: string
  onDocumentUpdated: (document: Document, replaceContent?: boolean) => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { preferences } = useTheme()
  const threadStorageKey = THREAD_STORAGE_KEY
  const [threadId, setThreadId] = useState<string | null>(() => localStorage.getItem(threadStorageKey))
  const [pendingPublication, setPendingPublication] = useState<PublishConfirmationRequest | null>(null)
  const [publishError, setPublishError] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [published, setPublished] = useState<IssuedPublication | null>(null)
  const [openedCitation, setOpenedCitation] = useState<CitationTarget | null>(null)
  const publishResolver = useRef<((result: Record<string, unknown>) => void) | null>(null)
  const configQuery = useQuery({ queryKey: ['chat-config'], queryFn: api.chatConfig })
  const proposalsQuery = useQuery({
    queryKey: ['chat-proposals', document.document_id, threadId],
    queryFn: () => api.listChatProposals(document.document_id, threadId ?? undefined),
    enabled: configQuery.data?.configured === true,
  })
  useEffect(() => {
    if (!configQuery.data?.configured || customElements.get('openai-chatkit')) return
    if (window.document.querySelector(`script[src="${CHATKIT_SCRIPT_SRC}"]`)) return
    const script = window.document.createElement('script')
    script.src = CHATKIT_SCRIPT_SRC
    script.async = true
    window.document.head.append(script)
  }, [configQuery.data?.configured])
  const refreshProposals = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: ['chat-proposals', document.document_id, threadId],
      }),
    [document.document_id, queryClient, threadId],
  )
  const requestPublishConfirmation = useCallback((params: Record<string, unknown>) => {
    const request = parsePublishConfirmation(params)
    if (!request) return Promise.resolve({ approved: false, error: 'Invalid publication request' })
    publishResolver.current?.({ approved: false, status: 'superseded' })
    setPendingPublication(request)
    setPublishError(false)
    setPublished(null)
    return new Promise<Record<string, unknown>>((resolve) => {
      publishResolver.current = resolve
    })
  }, [])
  useEffect(
    () => () => {
      publishResolver.current?.({ approved: false, status: 'cancelled', reason: 'Chat panel closed' })
      publishResolver.current = null
    },
    [],
  )
  // ChatKit initializes a heavy web-component session from its options. To keep a
  // single instance alive across document-tab switches, the options must stay
  // referentially stable; the live document/selection/refresh are read through a
  // ref instead of being baked into the options on every render.
  const liveRef = useRef({
    documentId: document.document_id,
    revisionId: document.current_revision_id,
    selectedText,
    refreshProposals,
    navigate,
    requestPublishConfirmation,
  })
  useEffect(() => {
    liveRef.current = {
      documentId: document.document_id,
      revisionId: document.current_revision_id,
      selectedText,
      refreshProposals,
      navigate,
      requestPublishConfirmation,
    }
  })
  const customFetch = useCallback((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set('X-Sangam-Document-ID', liveRef.current.documentId)
    return fetch(input, { ...init, headers })
  }, [])
  const models = useMemo(
    () =>
      (configQuery.data?.available_models ?? []).map((model) => ({
        id: model,
        label: model.replace(/^openai\//, ''),
        description: 'OpenRouter · OpenAI Responses',
        default: model === configQuery.data?.default_model,
      })),
    [configQuery.data],
  )
  const chatkit = useChatKit({
    api: {
      url: '/api/v1/chatkit',
      domainKey: configQuery.data?.domain_key ?? 'local-dev',
      fetch: customFetch,
    },
    frameTitle: 'Workspace chat',
    initialThread: threadId,
    theme: preferences.theme === 'midnight' ? 'dark' : 'light',
    header: { enabled: true, title: { text: 'Workspace chat' } },
    history: { enabled: true, showDelete: true, showRename: true },
    startScreen: {
      greeting: 'Ask about this workspace',
      prompts: [
        { label: 'Summarize this document', prompt: 'Summarize the current document with citations.' },
        { label: 'Review selected text', prompt: 'Review the selected text and suggest improvements.' },
      ],
    },
    composer: {
      placeholder: 'Ask about this workspace…',
      models,
      attachments: { enabled: false },
    },
    disclaimer: { text: 'Edits stay as proposals until you review and apply the diff.' },
    threadItemActions: { retry: true, feedback: false },
    thread: { autoScroll: true },
    onClientTool: ({ name, params }) => {
      if (name === 'get_editor_selection') {
        return {
          document_id: liveRef.current.documentId,
          revision_id: liveRef.current.revisionId,
          selected_text: liveRef.current.selectedText.slice(0, SELECTION_LIMIT),
        }
      }
      if (name === 'confirm_publish_document') return liveRef.current.requestPublishConfirmation(params)
      return { error: 'Unknown client tool' }
    },
    onThreadChange: ({ threadId: nextThreadId }) => {
      setThreadId(nextThreadId)
      if (nextThreadId) localStorage.setItem(threadStorageKey, nextThreadId)
      else localStorage.removeItem(threadStorageKey)
    },
    onResponseEnd: () => void liveRef.current.refreshProposals(),
    onDeeplink: ({ name, data }) => {
      if (name !== 'document') return
      const target = citationTargetFromData(data)
      if (!target) return
      setOpenedCitation(target)
      void liveRef.current.navigate({ href: citationHref(target) }).then(() => {
        announceCitationNavigation(target)
      })
    },
  })

  const cancelPublication = () => {
    publishResolver.current?.({ approved: false, status: 'cancelled' })
    publishResolver.current = null
    setPendingPublication(null)
    setPublishError(false)
  }
  const approvePublication = async () => {
    if (!pendingPublication || publishing) return
    setPublishing(true)
    setPublishError(false)
    try {
      const result = await api.createPublication(
        pendingPublication.documentId,
        pendingPublication.slug,
        pendingPublication.accessPolicy,
      )
      await queryClient.invalidateQueries({ queryKey: ['publication', pendingPublication.documentId] })
      publishResolver.current?.({
        approved: true,
        status: 'published',
        publication_id: result.publication_id,
        url: result.url,
        access_policy: result.access_policy,
      })
      publishResolver.current = null
      setPublished(result)
      setPendingPublication(null)
    } catch {
      setPublishError(true)
    } finally {
      setPublishing(false)
    }
  }

  if (configQuery.isLoading) return <div className="center-message">Preparing workspace chat…</div>
  if (configQuery.isError || !configQuery.data) {
    return <p className="error-text">Chat configuration could not be loaded.</p>
  }
  if (!configQuery.data.configured) {
    return (
      <div className="chat-unconfigured notice">
        Set <code>SANGAM_OPENROUTER_API_KEY</code> to enable the OpenRouter agent runtime.
      </div>
    )
  }

  return (
    <div className="chat-panel">
      <SelectionChip selectedText={selectedText} />
      {openedCitation && (
        <CitationNavigationStatus
          target={openedCitation}
          currentDocument={document}
          onClose={() => setOpenedCitation(null)}
        />
      )}
      {pendingPublication && (
        <PublishConfirmationCard
          request={pendingPublication}
          publishing={publishing}
          error={publishError}
          onApprove={() => void approvePublication()}
          onCancel={cancelPublication}
        />
      )}
      {published && <PublishedFromChat result={published} onDismiss={() => setPublished(null)} />}
      <ChatKit control={chatkit.control} className="chatkit-frame" />
      <ProposalReviewList
        proposals={proposalsQuery.data ?? []}
        document={document}
        onDocumentUpdated={onDocumentUpdated}
        onChanged={() => void refreshProposals()}
      />
    </div>
  )
}

export function parsePublishConfirmation(params: Record<string, unknown>): PublishConfirmationRequest | null {
  const documentId = typeof params.document_id === 'string' ? params.document_id.trim() : ''
  const documentTitle = typeof params.document_title === 'string' ? params.document_title.trim() : ''
  const slug = typeof params.slug === 'string' ? params.slug.trim() : ''
  const accessPolicy = params.access_policy
  if (
    !documentId ||
    documentId.length > 200 ||
    !slug ||
    slug.length > 200 ||
    !['private', 'unlisted', 'public'].includes(String(accessPolicy))
  ) {
    return null
  }
  return {
    documentId,
    documentTitle: documentTitle || 'Untitled document',
    slug,
    accessPolicy: accessPolicy as Publication['access_policy'],
  }
}

export function PublishConfirmationCard({
  request,
  publishing,
  error,
  onApprove,
  onCancel,
}: {
  request: PublishConfirmationRequest
  publishing: boolean
  error: boolean
  onApprove: () => void
  onCancel: () => void
}) {
  const reach = {
    private: 'Only authenticated Sangam users can open it.',
    unlisted: 'Anyone with the one-time access link can open it.',
    public: 'Anyone who knows or discovers the URL can open it.',
  }[request.accessPolicy]
  return (
    <section className="chat-effect-confirmation" role="alertdialog" aria-labelledby="publish-confirm-title">
      <div>
        <p className="eyebrow">External side effect</p>
        <strong id="publish-confirm-title">Publish “{request.documentTitle}”?</strong>
        <span>
          Chat requested <b>{request.accessPolicy}</b> access at <code>/p/{request.slug}</code>. {reach}
        </span>
        <small>No publication is created unless you approve this exact request.</small>
        {error && (
          <p className="error-text">
            Publishing failed. Nothing was confirmed to the assistant; retry or cancel.
          </p>
        )}
      </div>
      <div className="chat-effect-actions">
        <button type="button" className="primary-button" disabled={publishing} onClick={onApprove}>
          {publishing ? 'Publishing…' : `Approve ${request.accessPolicy} publication`}
        </button>
        <button type="button" className="secondary-action" disabled={publishing} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  )
}

function PublishedFromChat({ result, onDismiss }: { result: IssuedPublication; onDismiss: () => void }) {
  const href = result.url
  if (result.token) {
    return (
      <OneTimeSecret
        compact
        title="Publication approved · copy this link now"
        description="The access token is shown only in your browser and is not returned to the assistant."
        value={`${href}#token=${result.token}`}
        copyLabel="Copy publication link"
        dismissLabel="I saved it"
        onDismiss={onDismiss}
      />
    )
  }
  return (
    <div className="chat-effect-complete" role="status">
      <span>Publication approved and created.</span>
      <a href={href} target="_blank" rel="noreferrer">
        Open publication
      </a>
      <button type="button" className="secondary-action" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  )
}

export function CitationNavigationStatus({
  target,
  currentDocument,
  onClose,
}: {
  target: CitationTarget
  currentDocument: Document
  onClose: () => void
}) {
  const atDocument = currentDocument.document_id === target.documentId
  const stale = atDocument && target.revisionId && target.revisionId !== currentDocument.current_revision_id
  return (
    <aside className={`chat-citation-status ${stale ? 'stale' : ''}`} aria-label="Opened chat citation">
      <div>
        <strong>
          {stale
            ? 'Source changed since the answer'
            : atDocument
              ? 'Opened cited evidence'
              : 'Opening cited evidence…'}
        </strong>
        <small>
          {target.revisionId ? `Revision ${shortId(target.revisionId)}` : 'Current revision'}
          {target.pageNumber ? ` · PDF page ${target.pageNumber}` : ''}
          {target.annotationId ? ` · annotation ${shortId(target.annotationId)}` : ''}
        </small>
      </div>
      <button type="button" className="secondary-action" onClick={onClose}>
        Dismiss
      </button>
    </aside>
  )
}

function shortId(value: string) {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
}

export function SelectionChip({ selectedText }: { selectedText: string }) {
  if (selectedText.length === 0) return null
  const truncated = selectedText.length > SELECTION_LIMIT
  const sentCount = Math.min(selectedText.length, SELECTION_LIMIT)
  const preview = selectedText.slice(0, SELECTION_LIMIT)
  return (
    <details className="chat-selection-chip">
      <summary>
        <span className="chat-selection-chip-label">
          {truncated
            ? `Using selection: ${sentCount.toLocaleString()} of ${selectedText.length.toLocaleString()} chars (truncated)`
            : `Using selection: ${sentCount.toLocaleString()} chars`}
        </span>
      </summary>
      <pre className="chat-selection-chip-preview">{preview}</pre>
      {truncated && (
        <p className="chat-selection-chip-note">
          Only the first {SELECTION_LIMIT.toLocaleString()} characters are sent to the assistant. Narrow your
          selection to send a specific passage.
        </p>
      )}
    </details>
  )
}

function ProposalReviewList({
  proposals,
  document,
  onDocumentUpdated,
  onChanged,
}: {
  proposals: ChatProposal[]
  document: Document
  onDocumentUpdated: (document: Document, replaceContent?: boolean) => void
  onChanged: () => void
}) {
  const reviewable = proposals.filter(
    (proposal) => proposal.status === 'pending' || proposal.status === 'stale',
  )
  if (reviewable.length === 0) {
    return <p className="chat-proposals-empty small-muted">No pending edits to review.</p>
  }
  return (
    <section className="chat-proposals" aria-label="Chat edit proposals">
      <p className="eyebrow">Review proposed edits</p>
      {reviewable.map((proposal) => (
        <ProposalReview
          key={proposal.proposal_id}
          proposal={proposal}
          document={document}
          onDocumentUpdated={onDocumentUpdated}
          onChanged={onChanged}
        />
      ))}
    </section>
  )
}

function ProposalReview({
  proposal,
  document,
  onDocumentUpdated,
  onChanged,
}: {
  proposal: ChatProposal
  document: Document
  onDocumentUpdated: (document: Document, replaceContent?: boolean) => void
  onChanged: () => void
}) {
  const [dismissing, setDismissing] = useState(false)
  const [reason, setReason] = useState('')
  const apply = useMutation({
    mutationFn: () => api.applyChatProposal(proposal),
    onSuccess: async () => {
      onDocumentUpdated(await api.getDocument(document.document_id), true)
      onChanged()
    },
    onError: onChanged,
  })
  const dismiss = useMutation({
    mutationFn: () => api.dismissChatProposal(proposal.proposal_id, reason),
    onSuccess: onChanged,
  })
  const reload = useMutation({
    mutationFn: () => api.getDocument(document.document_id),
    onSuccess: (nextDocument) => {
      onDocumentUpdated(nextDocument, true)
      onChanged()
    },
  })
  const current = document.current_revision_id === proposal.expected_revision_id
  const isStale = proposal.status === 'stale' || apply.isError
  const busy = apply.isPending || dismiss.isPending || reload.isPending
  return (
    <article className="chat-proposal">
      <header>
        <strong>{proposal.summary ?? 'Proposed document edit'}</strong>
        <span className={`scope-badge ${current && !isStale ? 'workspace' : ''}`}>
          {isStale ? 'Document changed' : current ? 'Ready to review' : 'Document changed'}
        </span>
      </header>
      <RevisionMergeView original={document.content} modified={proposal.content} />
      {isStale && (
        <div className="chat-proposal-stale">
          <p className="error-text">
            The document changed while you were reviewing, so this edit can no longer apply. Reload to see the
            current text, then ask again if you still want the change.
          </p>
          <button className="secondary-action" disabled={busy} onClick={() => reload.mutate()}>
            {reload.isPending ? 'Reloading…' : 'Reload document'}
          </button>
        </div>
      )}
      {dismissing ? (
        <div className="chat-proposal-dismiss">
          <label>
            Reason for dismissing (optional)
            <input
              value={reason}
              maxLength={500}
              placeholder="e.g. Wrong section, or I edited it myself"
              onChange={(event) => setReason(event.target.value)}
              autoFocus
            />
          </label>
          <div className="chat-proposal-actions">
            <button className="primary-button" disabled={busy} onClick={() => dismiss.mutate()}>
              {dismiss.isPending ? 'Dismissing…' : 'Confirm dismiss'}
            </button>
            <button
              className="secondary-action"
              disabled={busy}
              onClick={() => {
                setDismissing(false)
                setReason('')
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="chat-proposal-actions">
          {!isStale && (
            <button className="primary-button" disabled={!current || busy} onClick={() => apply.mutate()}>
              {apply.isPending ? 'Applying…' : 'Apply reviewed edit'}
            </button>
          )}
          <button className="secondary-action" disabled={busy} onClick={() => setDismissing(true)}>
            Dismiss
          </button>
        </div>
      )}
      {dismiss.isError && <p className="error-text">The proposal could not be dismissed.</p>}
    </article>
  )
}
