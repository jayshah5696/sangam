import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ChatKit, useChatKit } from '@openai/chatkit-react'
import { api, type ChatProposal, type Document } from '../api'
import { useTheme } from '../theme'
import { RevisionMergeView } from './RevisionMergeView'

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
  const threadStorageKey = `sangam.chat-thread.${document.document_id}`
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
  const customFetch = useCallback(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.set('X-Sangam-Document-ID', document.document_id)
      return fetch(input, { ...init, headers })
    },
    [document.document_id],
  )
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
    frameTitle: `Chat about ${document.title}`,
    initialThread: threadId,
    theme: preferences.theme === 'midnight' ? 'dark' : 'light',
    header: { enabled: true, title: { text: 'Workspace chat' } },
    history: { enabled: true, showDelete: true, showRename: true },
    startScreen: {
      greeting: `Ask about ${document.title}`,
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
        document_id: document.document_id,
        revision_id: document.current_revision_id,
        selected_text: selectedText.slice(0, 20_000),
      }
    },
    onThreadChange: ({ threadId: nextThreadId }) => {
      setThreadId(nextThreadId)
      if (nextThreadId) localStorage.setItem(threadStorageKey, nextThreadId)
      else localStorage.removeItem(threadStorageKey)
    },
    onResponseEnd: () => void refreshProposals(),
    onDeeplink: ({ name, data }) => {
      if (name !== 'document' || typeof data?.document_id !== 'string') return
      void navigate({
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
  const pending = proposals.filter((proposal) => proposal.status === 'pending')
  if (pending.length === 0) return null
  return (
    <section className="chat-proposals" aria-label="Chat edit proposals">
      <p className="eyebrow">Review proposed edits</p>
      {pending.map((proposal) => (
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
  const apply = useMutation({
    mutationFn: () => api.applyChatProposal(proposal),
    onSuccess: async () => {
      onDocumentUpdated(await api.getDocument(document.document_id), true)
      onChanged()
    },
    onError: onChanged,
  })
  const dismiss = useMutation({
    mutationFn: () => api.dismissChatProposal(proposal.proposal_id),
    onSuccess: onChanged,
  })
  const current = document.current_revision_id === proposal.expected_revision_id
  return (
    <article className="chat-proposal">
      <header>
        <strong>{proposal.summary ?? 'Proposed document edit'}</strong>
        <span className={`scope-badge ${current ? 'workspace' : ''}`}>
          {current ? 'Ready to review' : 'Document changed'}
        </span>
      </header>
      <RevisionMergeView original={document.content} modified={proposal.content} />
      {apply.isError && <p className="error-text">The proposal is stale. Refresh and try again.</p>}
      <div className="chat-proposal-actions">
        <button
          className="primary-button"
          disabled={!current || apply.isPending || dismiss.isPending}
          onClick={() => apply.mutate()}
        >
          Apply reviewed edit
        </button>
        <button
          className="secondary-action"
          disabled={apply.isPending || dismiss.isPending}
          onClick={() => dismiss.mutate()}
        >
          Dismiss
        </button>
      </div>
    </article>
  )
}
