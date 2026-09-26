import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Check, ExternalLink, X } from 'lucide-react'
import { api, type ChatProposal, type DocumentSummary } from './api'
import { citationHref } from './citationNavigation'
import { RevisionMergeView } from './components/RevisionMergeView'
import { StateMessage } from './components/ui/StateMessage'
import { useWorkbench } from './workbench'

type ProposalStatus = Pick<ChatProposal, 'status'>
type ReviewQueryClient = {
  invalidateQueries: (filters: { queryKey: readonly string[] }) => Promise<void>
}

export function reviewableProposals<T extends ProposalStatus>(proposals: T[]): T[] {
  return proposals.filter((proposal) => proposal.status === 'pending' || proposal.status === 'stale')
}

export async function refreshReviewQueries(queryClient: ReviewQueryClient, documentId: string) {
  await queryClient.invalidateQueries({ queryKey: ['chat-proposals', 'workspace-review'] })
  await queryClient.invalidateQueries({ queryKey: ['documents'] })
  await queryClient.invalidateQueries({ queryKey: ['document', documentId] })
}

export function ReviewInbox() {
  const proposals = useQuery({
    queryKey: ['chat-proposals', 'workspace-review'],
    queryFn: () => api.listChatProposals(),
  })
  const documents = useQuery({ queryKey: ['documents'], queryFn: api.listDocuments })
  const reviewable = reviewableProposals(proposals.data ?? [])
  const documentsById = useMemo(
    () => new Map((documents.data ?? []).map((document) => [document.document_id, document])),
    [documents.data],
  )

  if (proposals.isLoading || documents.isLoading) {
    return <StateMessage kind="loading" title="Loading workspace review" />
  }
  if (proposals.isError || documents.isError) {
    return (
      <StateMessage
        kind="error"
        title="Review inbox could not be loaded"
        description="Refresh the workspace and try again. No proposal was changed."
      />
    )
  }
  return (
    <section className="review-page" aria-labelledby="review-title">
      <header className="review-page-header">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1 id="review-title">Review changes</h1>
          <p>Agent proposals stay here until you apply or dismiss them.</p>
        </div>
        <span className="review-count" aria-label={`${reviewable.length} proposals need review`}>
          {reviewable.length}
        </span>
      </header>
      {reviewable.length === 0 ? (
        <StateMessage
          kind="empty"
          title="Nothing needs review"
          description="New agent edits will appear here with their document and revision evidence."
        />
      ) : (
        <div className="review-list">
          {reviewable.map((proposal) => (
            <ProposalCard
              key={proposal.proposal_id}
              proposal={proposal}
              documentSummary={documentsById.get(proposal.document_id)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function ProposalCard({
  proposal,
  documentSummary,
}: {
  proposal: ChatProposal
  documentSummary?: DocumentSummary
}) {
  const navigate = useNavigate()
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  const [reason, setReason] = useState('')
  const documentQuery = useQuery({
    queryKey: ['document', proposal.document_id, 'review'],
    queryFn: () => api.getDocument(proposal.document_id),
  })
  const historyQuery = useQuery({
    queryKey: ['document', proposal.document_id, 'history', 'review'],
    queryFn: () => api.history(proposal.document_id),
    enabled: Boolean(documentQuery.data),
  })
  const apply = useMutation({
    mutationFn: () => api.applyChatProposal(proposal),
    onSuccess: () => refreshReviewQueries(queryClient, proposal.document_id),
    onError: () => refreshReviewQueries(queryClient, proposal.document_id),
  })
  const dismiss = useMutation({
    mutationFn: () => api.dismissChatProposal(proposal.proposal_id, reason),
    onSuccess: async () => {
      setReason('')
      await queryClient.invalidateQueries({ queryKey: ['chat-proposals', 'workspace-review'] })
    },
  })
  const document = documentQuery.data
  const expectedRevision = historyQuery.data?.find(
    (revision) => revision.revision_id === proposal.expected_revision_id,
  )
  const original = expectedRevision?.content ?? document?.content ?? ''
  const current = document?.current_revision_id === proposal.expected_revision_id
  const busy = apply.isPending || dismiss.isPending
  const openDocument = () => {
    workbench.ensureDocumentOpen(proposal.document_id, document?.title ?? documentSummary?.title)
    void navigate({ to: '/documents/$documentId', params: { documentId: proposal.document_id } })
  }

  return (
    <article className="review-card">
      <header className="review-card-header">
        <div>
          <p className="eyebrow">{document?.title ?? documentSummary?.title ?? 'Document proposal'}</p>
          <h2>{proposal.summary ?? 'Proposed document edit'}</h2>
        </div>
        <span className={`scope-badge ${current ? 'workspace' : ''}`}>
          {current ? 'Ready to review' : 'Document changed'}
        </span>
      </header>
      <div className="review-evidence">
        <span>Proposal {proposal.proposal_id.slice(0, 8)}</span>
        <span>Source thread {proposal.thread_id.slice(0, 8)}</span>
        <span>Revision {proposal.expected_revision_id.slice(0, 8)}</span>
        <time dateTime={proposal.created_at}>{new Date(proposal.created_at).toLocaleString()}</time>
      </div>
      {proposal.evidence ? (
        <div className="review-source" aria-label="Proposal source evidence">
          <div className="review-source-header">
            <span className="eyebrow">Source evidence</span>
            <a
              href={citationHref({
                documentId: proposal.evidence.document_id,
                revisionId: proposal.evidence.revision_id,
                pageNumber: proposal.evidence.pdf_page_number ?? undefined,
                annotationId: proposal.evidence.annotation_id ?? undefined,
              })}
            >
              Open source
            </a>
          </div>
          <p className="review-source-meta">
            Revision {proposal.evidence.revision_id.slice(0, 8)}
            {proposal.evidence.pdf_page_number ? ` · PDF page ${proposal.evidence.pdf_page_number}` : ''}
          </p>
          {proposal.evidence.selected_text ? (
            <blockquote>{proposal.evidence.selected_text}</blockquote>
          ) : (
            <p className="review-source-empty">No passage was selected for this source.</p>
          )}
        </div>
      ) : proposal.evidence_status === 'unavailable' ? (
        <p className="review-source-empty">
          Source evidence is unavailable because that source was deleted or is no longer accessible.
        </p>
      ) : (
        <p className="review-source-empty">No source evidence recorded for this proposal.</p>
      )}
      {historyQuery.isLoading || documentQuery.isLoading ? (
        <StateMessage compact kind="loading" title="Preparing revision evidence" />
      ) : (
        <RevisionMergeView original={original} modified={proposal.content} />
      )}
      {!current && (
        <p className="review-stale" role="alert">
          This proposal was based on an older revision. Open the document and ask for a fresh proposal before
          applying it.
        </p>
      )}
      <div className="review-card-actions">
        <button className="primary-button" disabled={!current || busy} onClick={() => apply.mutate()}>
          <Check size="var(--icon-inline)" /> {apply.isPending ? 'Applying…' : 'Apply change'}
        </button>
        <button className="secondary-action" disabled={busy} onClick={() => dismiss.mutate()}>
          <X size="var(--icon-inline)" /> {dismiss.isPending ? 'Dismissing…' : 'Dismiss'}
        </button>
        <button className="secondary-action" disabled={busy} onClick={openDocument}>
          <ExternalLink size="var(--icon-inline)" /> Open document
        </button>
      </div>
      <label className="review-reason">
        <span>
          Dismissal note <small>(optional)</small>
        </span>
        <input
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why is this not useful?"
        />
      </label>
      {(apply.isError || dismiss.isError) && (
        <p className="error-text">The proposal could not be updated. Your document is unchanged.</p>
      )}
    </article>
  )
}

export function ReviewRoute() {
  return <ReviewInbox />
}
