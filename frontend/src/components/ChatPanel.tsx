import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ChatKit, useChatKit } from '@openai/chatkit-react'
import { api, type ChatProposal, type Document } from '../api'
import { useTheme } from '../theme'
import { RevisionMergeView } from './RevisionMergeView'

const SELECTION_LIMIT = 20_000

// One workspace-scoped chat thread persists across document tabs; the active
// document is passed as live context rather than switching threads per tab.
const THREAD_STORAGE_KEY = 'sangam.chat-thread.workspace'

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
  const configQuery = useQuery({ queryKey: ['chat-config'], queryFn: api.chatConfig })
  const proposalsQuery = useQuery({
    queryKey: ['chat-proposals', document.document_id, threadId],
    queryFn: () => api.listChatProposals(document.document_id, threadId ?? undefined),
  })
  const refreshProposals = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: ['chat-proposals', document.document_id, threadId],
      }),
    [document.document_id, queryClient, threadId],
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
  })
  useEffect(() => {
    liveRef.current = {
      documentId: document.document_id,
      revisionId: document.current_revision_id,
      selectedText,
      refreshProposals,
      navigate,
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
    onClientTool: ({ name }) => {
      if (name !== 'get_editor_selection') return { error: 'Unknown client tool' }
      return {
        document_id: liveRef.current.documentId,
        revision_id: liveRef.current.revisionId,
        selected_text: liveRef.current.selectedText.slice(0, SELECTION_LIMIT),
      }
    },
    onThreadChange: ({ threadId: nextThreadId }) => {
      setThreadId(nextThreadId)
      if (nextThreadId) localStorage.setItem(threadStorageKey, nextThreadId)
      else localStorage.removeItem(threadStorageKey)
    },
    onResponseEnd: () => void liveRef.current.refreshProposals(),
    onDeeplink: ({ name, data }) => {
      if (name !== 'document' || typeof data?.document_id !== 'string') return
      void liveRef.current.navigate({
        to: '/documents/$documentId',
        params: { documentId: data.document_id },
      })
    },
  })

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
