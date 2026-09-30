import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Check, ExternalLink, FileCode, MessageSquareQuote, Pencil, RotateCcw, X } from 'lucide-react'
import {
  api,
  type ChatProposal,
  type ChatProposalCitation,
  type ChatProposalSource,
  type DocumentSummary,
} from './api'
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
  const [editedContent, setEditedContent] = useState(proposal.content)
  const [editMode, setEditMode] = useState(false)
  const [showRevisionPrompt, setShowRevisionPrompt] = useState(false)
  const [revisionInstruction, setRevisionInstruction] = useState('')
  const [handoffError, setHandoffError] = useState(false)
  const revisionTrigger = useRef<HTMLButtonElement>(null)

  const documentQuery = useQuery({
    queryKey: ['document', proposal.document_id, 'review'],
    queryFn: () => api.getDocument(proposal.document_id),
  })
  const historyQuery = useQuery({
    queryKey: ['document', proposal.document_id, 'revision', proposal.expected_revision_id, 'review'],
    queryFn: () => api.revision(proposal.document_id, proposal.expected_revision_id),
    enabled: Boolean(documentQuery.data),
  })
  const apply = useMutation({
    mutationFn: (overrideContent?: string) => api.applyChatProposal(proposal, overrideContent),
    onSuccess: () => refreshReviewQueries(queryClient, proposal.document_id),
    onError: () => refreshReviewQueries(queryClient, proposal.document_id),
  })
  const dismiss = useMutation({
    mutationFn: (dismissalNote?: string) =>
      api.dismissChatProposal(proposal.proposal_id, dismissalNote ?? reason),
    onSuccess: async () => {
      setReason('')
      await queryClient.invalidateQueries({ queryKey: ['chat-proposals', 'workspace-review'] })
    },
  })
  const document = documentQuery.data
  const expectedRevision = historyQuery.data
  const original = expectedRevision?.content
  const current = document?.current_revision_id === proposal.expected_revision_id
  const busy = apply.isPending || dismiss.isPending
  const isEdited = editedContent !== proposal.content

  const openDocument = () => {
    workbench.ensureDocumentOpen(proposal.document_id, document?.title ?? documentSummary?.title)
    void navigate({ to: '/documents/$documentId', params: { documentId: proposal.document_id } })
  }

  const handleResetToProposal = () => {
    setEditedContent(proposal.content)
  }

  const handleRequestRevision = async () => {
    const instruction = revisionInstruction.trim()
    if (!instruction) return
    setHandoffError(false)
    const context = `Request a revision of proposal ${proposal.proposal_id} in thread ${proposal.thread_id}.\nDocument: ${proposal.document_id}\nReviewed revision: ${proposal.expected_revision_id}\nFeedback: ${instruction}`
    try {
      await navigate({
        to: '/chat',
        search: {
          document: proposal.document_id,
          thread: proposal.thread_id,
          proposal: proposal.proposal_id,
          prompt: context,
          returnTo: `/documents/${proposal.document_id}`,
        },
        state: {
          sangamChatInitialPrompt: `${context}\n\nExact reviewed wording:\n${editedContent}\n\nRead the current document and return a fresh proposal. Keep the original proposal available for review.`,
        },
      })
    } catch {
      setHandoffError(true)
    }
  }

  const closeRevisionPrompt = () => {
    setShowRevisionPrompt(false)
    revisionTrigger.current?.focus()
  }

  const citations: ChatProposalCitation[] = proposal.citations ?? []
  const sourcesRetrieved: ChatProposalSource[] = proposal.sources_retrieved ?? []

  return (
    <article className="review-card editorial-review-card">
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

      <div className="review-editorial-grid">
        <div className="review-editorial-left">
          <div className="review-editorial-context">
            <div className="review-editorial-section">
              <span className="eyebrow">What changed &amp; why</span>
              <p className="review-editorial-text">
                {proposal.rationale || proposal.summary || 'No rationale recorded for this edit.'}
              </p>
            </div>
            {proposal.model_opinion && (
              <div className="review-editorial-section">
                <span className="eyebrow">Model opinion</span>
                <p className="review-editorial-text">{proposal.model_opinion}</p>
                <p className="small-muted">
                  This is the model's interpretation, not a verified source passage.
                </p>
              </div>
            )}
            <div className="review-editorial-section">
              <span className="eyebrow">Judgment needed</span>
              <p className="review-editorial-text">
                {proposal.judgment_needed || 'No specific judgment recorded.'}
              </p>
            </div>
          </div>

          <div className="review-content-toolbar">
            <div className="review-toolbar-title-group">
              <span className="eyebrow">Proposed wording</span>
              {isEdited && <span className="review-edited-badge">Edited</span>}
            </div>
            <div className="review-toolbar-actions">
              {isEdited && (
                <button
                  type="button"
                  className="secondary-action"
                  onClick={handleResetToProposal}
                  title="Reset wording back to original agent proposal"
                >
                  <RotateCcw size="var(--icon-inline)" /> Reset to proposal
                </button>
              )}
              <button
                type="button"
                className="secondary-action"
                onClick={() => setEditMode((prev) => !prev)}
                aria-pressed={editMode}
              >
                {editMode ? (
                  <>
                    <FileCode size="var(--icon-inline)" /> View diff
                  </>
                ) : (
                  <>
                    <Pencil size="var(--icon-inline)" /> Edit wording
                  </>
                )}
              </button>
            </div>
          </div>

          {editMode ? (
            <div className="review-edit-container">
              <textarea
                className="review-edit-textarea"
                value={editedContent}
                onChange={(e) => setEditedContent(e.target.value)}
                rows={12}
                aria-label="Editable proposed wording"
              />
            </div>
          ) : historyQuery.isLoading || documentQuery.isLoading ? (
            <StateMessage compact kind="loading" title="Preparing revision evidence" />
          ) : historyQuery.isError || documentQuery.isError || original === undefined ? (
            <StateMessage
              compact
              kind="error"
              title="The reviewed revision could not be loaded"
              description="The current document has not been substituted for the reviewed revision."
            />
          ) : (
            <RevisionMergeView original={original} modified={editedContent} />
          )}
        </div>

        <div className="review-editorial-right">
          <div className="review-supporting-passages">
            <span className="eyebrow">Supporting passages</span>
            {citations.length > 0 ? (
              <div className="review-citations-list">
                {citations.map((citation, index) => (
                  <div key={index} className="review-citation-item">
                    <div className="review-source-header">
                      <span className="review-citation-title">
                        {citation.title ||
                          (citation.path
                            ? citation.path.split('/').pop()
                            : `Document ${citation.document_id.slice(0, 8)}`)}
                      </span>
                      {citation.available !== false && (
                        <a
                          href={citationHref({
                            documentId: citation.document_id,
                            revisionId: citation.revision_id ?? undefined,
                            pageNumber: citation.page_number ?? undefined,
                            annotationId: citation.annotation_id ?? undefined,
                            quoteStart: citation.quote_start ?? undefined,
                            quoteEnd: citation.quote_end ?? undefined,
                          })}
                        >
                          Open source
                        </a>
                      )}
                    </div>
                    <p className="review-source-meta">
                      {citation.location ? `Location: ${citation.location}` : ''}
                      {citation.location && citation.page_number ? ' · ' : ''}
                      {citation.page_number ? `Page ${citation.page_number}` : ''}
                      {(citation.location || citation.page_number) && citation.revision_id ? ' · ' : ''}
                      {citation.revision_id ? `Rev ${citation.revision_id.slice(0, 8)}` : ''}
                    </p>
                    {citation.snippet ? (
                      <blockquote>{citation.snippet}</blockquote>
                    ) : (
                      <StateMessage
                        compact
                        kind="empty"
                        title={
                          citation.available === false
                            ? 'Source passage deleted, changed, or inaccessible.'
                            : 'No excerpt provided.'
                        }
                      />
                    )}
                  </div>
                ))}
              </div>
            ) : proposal.evidence_status === 'unavailable' ? (
              <StateMessage compact kind="empty" title="Source document deleted or inaccessible." />
            ) : (
              <StateMessage compact kind="empty" title="No supporting passages recorded for this proposal." />
            )}
          </div>

          {proposal.evidence && (
            <div className="review-supporting-passages" aria-label="Recorded turn context">
              <span className="eyebrow">Recorded turn context</span>
              <p className="small-muted">
                This context was attached to the request. It is not cited support for a claim.
              </p>
              <div className="review-citation-item">
                <div className="review-source-header">
                  <span className="review-citation-title">Source context</span>
                  <a
                    href={citationHref({
                      documentId: proposal.evidence.document_id,
                      revisionId: proposal.evidence.revision_id,
                      pageNumber: proposal.evidence.pdf_page_number ?? undefined,
                      annotationId: proposal.evidence.annotation_id ?? undefined,
                    })}
                  >
                    Open turn context
                  </a>
                </div>
                <p className="review-source-meta">
                  Revision {proposal.evidence.revision_id.slice(0, 8)}
                  {proposal.evidence.pdf_page_number
                    ? ` · PDF page ${proposal.evidence.pdf_page_number}`
                    : ''}
                </p>
                {proposal.evidence.selected_text ? (
                  <blockquote>{proposal.evidence.selected_text}</blockquote>
                ) : (
                  <p className="review-source-empty">No passage was selected for this source.</p>
                )}
              </div>
            </div>
          )}

          <div className="review-retrieved-sources">
            <span className="eyebrow">Sources retrieved during turn</span>
            <p className="small-muted">
              Retrieval alone does not establish support for a claim. Up to 50 source references are recorded;
              supporting citations are limited to 20.
            </p>
            {proposal.sources_retrieved_truncated && (
              <StateMessage
                compact
                kind="empty"
                title="Source list truncated at 50 references"
                description="Additional sources were retrieved during this run."
              />
            )}
            {sourcesRetrieved.length > 0 ? (
              <ul className="review-sources-list">
                {sourcesRetrieved.map((source, index) => (
                  <li key={index} className="review-source-row">
                    <div className="review-source-row-info">
                      <a
                        href={citationHref({
                          documentId: source.document_id,
                          revisionId: source.revision_id ?? undefined,
                          pageNumber: source.page_number ?? undefined,
                        })}
                        className="review-source-row-title"
                      >
                        {source.title ||
                          (source.path ? source.path.split('/').pop() : source.document_id.slice(0, 8))}
                      </a>
                      <span className="review-source-meta">
                        {source.path || source.document_id.slice(0, 8)}
                        {source.page_number ? ` · Page ${source.page_number}` : ''}
                        {source.revision_id ? ` · Rev ${source.revision_id.slice(0, 8)}` : ''}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <StateMessage compact kind="empty" title="No retrieved sources available for this turn." />
            )}
          </div>
        </div>
      </div>

      {!current && (
        <StateMessage
          compact
          kind="error"
          title="This proposal was based on an older revision"
          description="Request a fresh proposal before applying it. Your reviewed wording is preserved."
        />
      )}

      <div className="review-card-actions">
        <button
          type="button"
          className="primary-button"
          disabled={!current || busy || !expectedRevision || documentQuery.isError || historyQuery.isError}
          onClick={() => apply.mutate(isEdited ? editedContent : undefined)}
        >
          <Check size="var(--icon-inline)" />{' '}
          {apply.isPending ? 'Applying…' : isEdited ? 'Apply edited change' : 'Apply change'}
        </button>
        <button
          type="button"
          className="secondary-action"
          disabled={busy}
          onClick={() => setShowRevisionPrompt((prev) => !prev)}
          aria-expanded={showRevisionPrompt}
          ref={revisionTrigger}
        >
          <MessageSquareQuote size="var(--icon-inline)" /> Request a revision
        </button>
        <button
          type="button"
          className="secondary-action"
          disabled={busy}
          onClick={() => dismiss.mutate(undefined)}
        >
          <X size="var(--icon-inline)" /> {dismiss.isPending ? 'Dismissing…' : 'Dismiss'}
        </button>
        <button type="button" className="secondary-action" disabled={busy} onClick={openDocument}>
          <ExternalLink size="var(--icon-inline)" /> Open document
        </button>
      </div>

      {showRevisionPrompt && (
        <div
          className="review-revision-prompt"
          role="region"
          aria-label="Request a revision"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              closeRevisionPrompt()
            }
          }}
        >
          <StateMessage
            compact
            kind="empty"
            title="Prepare feedback in the source conversation"
            description="Chat will open with this proposal, its exact reviewed wording, and your feedback in the composer. Review it and choose Send. This proposal stays available."
          />
          <label className="review-reason">
            <span>What should be revised?</span>
            <input
              value={revisionInstruction}
              maxLength={500}
              onChange={(event) => setRevisionInstruction(event.target.value)}
              placeholder="e.g. Tighten the second paragraph and include the metrics from the roadmap"
              autoFocus
            />
          </label>
          <div className="review-revision-actions">
            <button
              type="button"
              className="primary-button"
              disabled={!revisionInstruction.trim() || busy}
              onClick={handleRequestRevision}
            >
              Prepare revision request in chat
            </button>
            <button type="button" className="secondary-action" disabled={busy} onClick={closeRevisionPrompt}>
              Cancel
            </button>
          </div>
        </div>
      )}

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
      {apply.isError && (
        <StateMessage
          compact
          kind="error"
          title="The proposal could not be applied"
          description="Your reviewed wording is preserved. Check the document's current revision before retrying."
        />
      )}
      {dismiss.isError && (
        <StateMessage
          compact
          kind="error"
          title="The proposal could not be dismissed"
          description="Try again after any active apply finishes."
        />
      )}
      {handoffError && (
        <StateMessage
          compact
          kind="error"
          title="Chat could not be opened"
          description="Your feedback and proposal are preserved. Try preparing the request again."
        />
      )}
    </article>
  )
}

export function ReviewRoute() {
  return <ReviewInbox />
}
