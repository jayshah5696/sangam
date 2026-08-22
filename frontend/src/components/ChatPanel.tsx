import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ChatKit, useChatKit } from '@openai/chatkit-react'
import { FileText, X } from 'lucide-react'
import { api, type ChatProposal, type Document, type IssuedPublication, type Publication } from '../api'
import {
  announceCitationNavigation,
  citationHref,
  citationTargetFromData,
  type CitationTarget,
} from '../citationNavigation'
import { useTheme } from '../theme'
import { OneTimeSecret } from './OneTimeSecret'
import { StateMessage } from './ui/StateMessage'
import { RevisionMergeView } from './RevisionMergeView'
import {
  ChatCreateConfirmation,
  parseCreateConfirmation,
  type CreateConfirmationRequest,
} from './ChatCreateConfirmation'
import { useChatKitScript } from './useChatKitScript'

const SELECTION_LIMIT = 20_000
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
  onClearContext,
  compact = false,
}: {
  document?: Document | null
  selectedText?: string
  onDocumentUpdated?: (document: Document, replaceContent?: boolean) => void
  onClearContext?: () => void
  compact?: boolean
}) {
  const activeDocument = document ?? null
  const activeSelectedText = selectedText ?? ''
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { preferences } = useTheme()
  const threadStorageKey = THREAD_STORAGE_KEY
  const [threadId, setThreadId] = useState<string | null>(() => localStorage.getItem(threadStorageKey))
  const [chatEpoch, setChatEpoch] = useState(0)
  const [pendingPublication, setPendingPublication] = useState<PublishConfirmationRequest | null>(null)
  const [publishError, setPublishError] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [published, setPublished] = useState<IssuedPublication | null>(null)
  const [pendingCreate, setPendingCreate] = useState<CreateConfirmationRequest | null>(null)
  const [createError, setCreateError] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createdDocument, setCreatedDocument] = useState<Document | null>(null)
  const [openedCitation, setOpenedCitation] = useState<CitationTarget | null>(null)
  const publishResolver = useRef<((result: Record<string, unknown>) => void) | null>(null)
  const createResolver = useRef<((result: Record<string, unknown>) => void) | null>(null)
  const configQuery = useQuery({ queryKey: ['chat-config'], queryFn: api.chatConfig })
  const script = useChatKitScript(configQuery.isSuccess)
  const proposalsQuery = useQuery({
    queryKey: ['chat-proposals', activeDocument?.document_id ?? null, threadId],
    queryFn: () => api.listChatProposals(activeDocument?.document_id, threadId ?? undefined),
    enabled: configQuery.isSuccess,
  })
  const refreshProposals = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: ['chat-proposals', activeDocument?.document_id ?? null, threadId],
      }),
    [activeDocument?.document_id, queryClient, threadId],
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
  const requestCreateConfirmation = useCallback((params: Record<string, unknown>) => {
    const request = parseCreateConfirmation(params)
    if (!request) return Promise.resolve({ approved: false, error: 'Invalid creation request' })
    createResolver.current?.({ approved: false, status: 'superseded' })
    setPendingCreate(request)
    setCreateError(false)
    setCreatedDocument(null)
    return new Promise<Record<string, unknown>>((resolve) => {
      createResolver.current = resolve
    })
  }, [])
  useEffect(
    () => () => {
      publishResolver.current?.({ approved: false, status: 'cancelled', reason: 'Chat panel closed' })
      publishResolver.current = null
      createResolver.current?.({ approved: false, status: 'cancelled', reason: 'Chat panel closed' })
      createResolver.current = null
    },
    [],
  )
  // ChatKit initializes a heavy web-component session from its options. To keep a
  // single instance alive across document-tab switches, the options must stay
  // referentially stable; the live document/selection/refresh are read through a
  // ref instead of being baked into the options on every render.
  const liveRef = useRef({
    documentId: activeDocument?.document_id ?? null,
    revisionId: activeDocument?.current_revision_id ?? null,
    selectedText: activeSelectedText,
    refreshProposals,
    navigate,
    requestPublishConfirmation,
    requestCreateConfirmation,
  })
  useEffect(() => {
    liveRef.current = {
      documentId: activeDocument?.document_id ?? null,
      revisionId: activeDocument?.current_revision_id ?? null,
      selectedText: activeSelectedText,
      refreshProposals,
      navigate,
      requestPublishConfirmation,
      requestCreateConfirmation,
    }
  })
  const handleThreadChange = useCallback(
    ({ threadId: nextThreadId }: { threadId: string | null }) => {
      setThreadId(nextThreadId)
      if (nextThreadId) localStorage.setItem(threadStorageKey, nextThreadId)
      else localStorage.removeItem(threadStorageKey)
    },
    [threadStorageKey],
  )
  const handleResponseEnd = useCallback(() => void liveRef.current.refreshProposals(), [])
  const handleCitationDeeplink = useCallback(
    ({ name, data }: { name: string; data?: Record<string, unknown> }) => {
      if (name !== 'document') return
      const target = citationTargetFromData(data)
      if (!target) return
      setOpenedCitation(target)
      void liveRef.current.navigate({ href: citationHref(target) }).then(() => {
        announceCitationNavigation(target)
      })
    },
    [],
  )
  // A full remount is the only reliable way to recover a wedged ChatKit frame;
  // clearing the stored thread also protects against server-side resets that
  // would otherwise leave the frame blank with no visible error.
  const resetChatSurface = useCallback(() => {
    localStorage.removeItem(threadStorageKey)
    setThreadId(null)
    setChatEpoch((epoch) => epoch + 1)
  }, [threadStorageKey])
  const models = useMemo(
    () =>
      (configQuery.data?.available_models ?? []).map((model) => ({
        id: model.id,
        label: model.name,
        description: `${model.connection_name} · ${model.protocol === 'openai_responses' ? 'Responses' : 'Chat Completions'} · ${model.compatibility}`,
        default: model.id === configQuery.data?.default_model,
      })),
    [configQuery.data],
  )
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
  const cancelCreate = () => {
    createResolver.current?.({ approved: false, status: 'cancelled' })
    createResolver.current = null
    setPendingCreate(null)
    setCreateError(false)
  }
  const approveCreate = async () => {
    if (!pendingCreate || creating) return
    setCreating(true)
    setCreateError(false)
    try {
      const result = await api.createDocument(
        pendingCreate.title,
        undefined,
        pendingCreate.contentType,
        pendingCreate.content,
      )
      createResolver.current?.({
        approved: true,
        status: 'created',
        document_id: result.document_id,
        revision_id: result.current_revision_id,
      })
      createResolver.current = null
      setPendingCreate(null)
      setCreatedDocument(result)
      await queryClient.invalidateQueries({ queryKey: ['documents'] })
    } catch {
      setCreateError(true)
    } finally {
      setCreating(false)
    }
  }

  const lastDocumentIdRef = useRef(activeDocument?.document_id ?? null)
  const [contextSwitchEvent, setContextSwitchEvent] = useState<{
    documentTitle: string
    revisionId: string
  } | null>(null)

  useEffect(() => {
    const nextDocumentId = activeDocument?.document_id ?? null
    if (lastDocumentIdRef.current !== nextDocumentId) {
      lastDocumentIdRef.current = nextDocumentId
      setContextSwitchEvent(
        activeDocument
          ? { documentTitle: activeDocument.title, revisionId: activeDocument.current_revision_id }
          : null,
      )
    }
  }, [activeDocument])

  return (
    <div className={`chat-panel ${compact ? 'chat-panel-compact' : ''}`}>
      {!compact && (
        <ChatContextBanner
          document={activeDocument}
          selectedText={activeSelectedText}
          onClear={onClearContext}
        />
      )}
      {contextSwitchEvent && (
        <div className="chat-context-switch-event" role="status" aria-live="polite">
          <FileText size={13} />
          <span>
            Context switched to <strong>{contextSwitchEvent.documentTitle}</strong> (
            <code>rev {shortId(contextSwitchEvent.revisionId)}</code>)
          </span>
        </div>
      )}
      {configQuery.isLoading ? (
        <StateMessage kind="loading" title="Preparing workspace chat" />
      ) : configQuery.isError || !configQuery.data ? (
        <StateMessage
          kind="error"
          title="Chat configuration could not be loaded"
          description="Check the Sangam server, then retry."
          action={
            <button className="secondary-action" onClick={() => void configQuery.refetch()}>
              Retry
            </button>
          }
        />
      ) : configQuery.data.transport_status !== 'ready' ? (
        <StateMessage
          kind="error"
          title="ChatKit browser transport needs setup"
          description={configQuery.data.transport_message}
          action={
            <button className="secondary-action" onClick={() => void configQuery.refetch()}>
              Check again
            </button>
          }
        />
      ) : (
        <>
          {!configQuery.data.inference_enabled && (
            <div className={`chat-runtime-status status-${configQuery.data.status}`} role="status">
              <strong>{configQuery.data.status.replace('_', ' ')}</strong>
              <span>{configQuery.data.message} History and proposal review remain available.</span>
            </div>
          )}
          {!compact && <SelectionChip selectedText={activeSelectedText} />}
          {openedCitation && (
            <CitationNavigationStatus
              target={openedCitation}
              currentDocument={activeDocument}
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
          {pendingCreate && (
            <ChatCreateConfirmation
              request={pendingCreate}
              pending={creating}
              error={createError}
              onApprove={() => void approveCreate()}
              onCancel={cancelCreate}
            />
          )}
          {createdDocument && (
            <CreatedFromChat document={createdDocument} onDismiss={() => setCreatedDocument(null)} />
          )}
          {published && <PublishedFromChat result={published} onDismiss={() => setPublished(null)} />}
          {script.status === 'loading' && <StateMessage kind="loading" title="Loading chat interface" />}
          {script.status === 'error' && (
            <StateMessage
              kind="error"
              title="The ChatKit interface could not be loaded"
              description="The browser could not load ChatKit's script. Check the connection, then retry."
              action={
                <button className="secondary-action" onClick={script.retry}>
                  Retry ChatKit
                </button>
              }
            />
          )}
          {script.status === 'ready' && configQuery.data && (
            <WorkspaceChatSurface
              key={chatEpoch}
              liveRef={liveRef}
              theme={preferences.theme === 'midnight' ? 'dark' : 'light'}
              domainKey={configQuery.data.domain_key}
              inferenceEnabled={configQuery.data.inference_enabled}
              models={models}
              initialThreadId={threadId}
              onThreadChange={handleThreadChange}
              onResponseEnd={handleResponseEnd}
              hasDocument={Boolean(activeDocument)}
              hasSelection={Boolean(activeSelectedText)}
              onCitationDeeplink={handleCitationDeeplink}
              onReset={resetChatSurface}
              compact={compact}
            />
          )}
          {proposalsQuery.isLoading ? (
            activeDocument && <StateMessage compact kind="loading" title="Loading edit proposals" />
          ) : proposalsQuery.isError ? (
            <div className="chat-proposals-error" role="alert">
              <span>Proposals could not be loaded.</span>
              <button className="secondary-action" onClick={() => void proposalsQuery.refetch()}>
                Retry
              </button>
            </div>
          ) : (
            activeDocument &&
            onDocumentUpdated && (
              <ProposalReviewList
                proposals={proposalsQuery.data ?? []}
                document={activeDocument}
                onDocumentUpdated={onDocumentUpdated}
                onChanged={() => void refreshProposals()}
              />
            )
          )}
        </>
      )}
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

export function CreatedFromChat({ document, onDismiss }: { document: Document; onDismiss: () => void }) {
  const navigate = useNavigate()
  return (
    <div className="chat-effect-complete" role="status">
      <span>
        Created “{document.title}” · <code>{shortId(document.document_id)}</code>
      </span>
      <button
        type="button"
        className="secondary-action"
        onClick={() => void navigate({ href: `/documents/${document.document_id}` })}
      >
        Open document
      </button>
      <button type="button" className="secondary-action" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
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
  currentDocument: Document | null
  onClose: () => void
}) {
  const atDocument = currentDocument?.document_id === target.documentId
  const stale = Boolean(
    atDocument && target.revisionId && target.revisionId !== currentDocument?.current_revision_id,
  )
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

export function ChatContextBanner({
  document,
  selectedText,
  onClear,
}: {
  document: Document | null
  selectedText: string
  onClear?: () => void
}) {
  return (
    <div className="chat-context-banner" aria-label="Active chat context">
      <div className="chat-context-main">
        <span className="chat-context-title">{document?.title ?? 'Whole workspace'}</span>
        <span className="chat-context-meta">
          {document ? <code>rev {shortId(document.current_revision_id)}</code> : 'No document pinned'}
          {selectedText.length > 0 && <span> · {selectedText.length.toLocaleString()} chars selected</span>}
        </span>
      </div>
      {document && onClear && (
        <button type="button" className="icon-button" aria-label="Remove document context" onClick={onClear}>
          <X size={14} />
        </button>
      )}
    </div>
  )
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
  if (reviewable.length === 0) return null
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

type ChatFramePhase = 'connecting' | 'ready' | 'error'

const CHAT_FRAME_TIMEOUT_MS = 15_000

type LiveChatContext = {
  documentId: string | null
  revisionId: string | null
  selectedText: string
  refreshProposals: () => void
  navigate: ReturnType<typeof useNavigate>
  requestPublishConfirmation: (params: Record<string, unknown>) => Promise<Record<string, unknown>>
  requestCreateConfirmation: (params: Record<string, unknown>) => Promise<Record<string, unknown>>
}

export function hasMountedChatInterface(host: HTMLElement) {
  const root = host.shadowRoot
  if (!root) return false
  return Boolean(root.querySelector('iframe, .ck-wrapper, [contenteditable="true"], textarea'))
}

function WorkspaceChatSurface({
  liveRef,
  theme,
  domainKey,
  inferenceEnabled,
  models,
  initialThreadId,
  onThreadChange,
  onResponseEnd,
  hasDocument,
  hasSelection,
  onCitationDeeplink,
  onReset,
  compact,
}: {
  liveRef: React.MutableRefObject<LiveChatContext>
  theme: 'dark' | 'light'
  domainKey: string
  inferenceEnabled: boolean
  models: Array<{ id: string; label: string; description: string; default?: boolean }>
  initialThreadId: string | null
  onThreadChange: (thread: { threadId: string | null }) => void
  onResponseEnd: () => void
  hasDocument: boolean
  hasSelection: boolean
  onCitationDeeplink: (event: { name: string; data?: Record<string, unknown> }) => void
  onReset: () => void
  compact: boolean
}) {
  const [phase, setPhase] = useState<ChatFramePhase>('connecting')
  useEffect(() => {
    // ChatKit can fail silently (blocked CDN subresource, stale thread id after a
    // server reset). If the frame never reports ready, surface a recoverable
    // error instead of leaving the panel blank.
    const timeout = window.setTimeout(
      () => setPhase((current) => (current === 'connecting' ? 'error' : current)),
      CHAT_FRAME_TIMEOUT_MS,
    )
    return () => window.clearTimeout(timeout)
  }, [])
  const customFetch = useCallback(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      if (liveRef.current.documentId) {
        headers.set('X-Sangam-Document-ID', liveRef.current.documentId)
        if (liveRef.current.revisionId) headers.set('X-Sangam-Revision-ID', liveRef.current.revisionId)
        else headers.delete('X-Sangam-Revision-ID')
        headers.delete('X-Sangam-Workspace-Context')
      } else {
        headers.delete('X-Sangam-Document-ID')
        headers.delete('X-Sangam-Revision-ID')
        headers.set('X-Sangam-Workspace-Context', '1')
      }
      return fetch(input, { ...init, headers })
    },
    [liveRef],
  )
  const chatkit = useChatKit({
    api: {
      url: '/api/v1/chatkit',
      domainKey,
      fetch: customFetch,
    },
    frameTitle: 'Workspace chat',
    initialThread: initialThreadId ?? undefined,
    theme,
    header: compact ? { enabled: false } : { enabled: true, title: { text: 'Workspace chat' } },
    history: { enabled: !compact, showDelete: !compact, showRename: !compact },
    startScreen: {
      greeting: compact ? 'Ask about this document' : 'Ask about this workspace',
      prompts: [
        {
          label: hasDocument ? 'Summarize this document' : 'Find related work',
          prompt: hasDocument
            ? 'Summarize the current document with citations.'
            : 'Find related documents in this workspace and summarize their connection with citations.',
        },
        {
          label: hasSelection
            ? 'Review selected text'
            : hasDocument
              ? 'Find related documents'
              : 'Search the workspace',
          prompt: hasSelection
            ? 'Review the selected text and suggest improvements.'
            : hasDocument
              ? 'Find documents related to the current document and explain the connection with citations.'
              : 'Search the workspace for the most important recent material and cite the sources.',
        },
      ],
    },
    composer: {
      placeholder: inferenceEnabled
        ? compact
          ? 'Ask about this document…'
          : 'Ask about this workspace…'
        : 'Inference unavailable · history remains readable',
      models,
      attachments: { enabled: false },
    },
    disclaimer: compact
      ? undefined
      : { text: 'Edits stay as proposals until you review and apply the diff.' },
    threadItemActions: { retry: true, feedback: false },
    thread: { autoScroll: true },
    onReady: () => {
      // `chatkit.ready` only means the host initialized. Domain verification and
      // iframe mounting happen afterward, so keep waiting for usable UI.
    },
    onError: () => setPhase('error'),
    onClientTool: ({ name, params }) => {
      if (name === 'get_editor_selection') {
        return {
          document_id: liveRef.current.documentId,
          revision_id: liveRef.current.revisionId,
          selected_text: liveRef.current.selectedText.slice(0, SELECTION_LIMIT),
        }
      }
      if (name === 'confirm_publish_document') return liveRef.current.requestPublishConfirmation(params)
      if (name === 'confirm_create_document') return liveRef.current.requestCreateConfirmation(params)
      return { error: 'Unknown client tool' }
    },
    onThreadChange,
    onResponseEnd,
    onDeeplink: onCitationDeeplink,
  })
  const chatkitHostRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    let stopped = false
    let observedRoot: ShadowRoot | null = null
    const observer = new MutationObserver(() => check())
    const check = () => {
      const host = chatkitHostRef.current
      if (!host || stopped) return
      if (host.shadowRoot && host.shadowRoot !== observedRoot) {
        observer.disconnect()
        observedRoot = host.shadowRoot
        observer.observe(observedRoot, { childList: true, subtree: true })
      }
      if (hasMountedChatInterface(host)) setPhase('ready')
    }
    check()
    const interval = window.setInterval(check, 250)
    return () => {
      stopped = true
      observer.disconnect()
      window.clearInterval(interval)
    }
  }, [])
  return (
    <div className={`chatkit-shell phase-${phase}`}>
      <ChatKit
        ref={(host) => {
          chatkitHostRef.current = host
        }}
        control={chatkit.control}
        className="chatkit-frame"
      />
      {phase === 'connecting' && (
        <div className="chatkit-state-overlay">
          <StateMessage kind="loading" title="Connecting to workspace chat" />
        </div>
      )}
      {phase === 'error' && (
        <div className="chatkit-state-overlay">
          <StateMessage
            kind="error"
            title="Workspace chat could not finish loading"
            description="ChatKit did not mount a composer. Check domain registration and the browser connection, then retry."
            action={
              <button className="secondary-action" onClick={onReset}>
                Retry workspace chat
              </button>
            }
          />
        </div>
      )}
    </div>
  )
}
