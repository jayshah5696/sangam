import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowLeftRight,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  GitFork,
  Trash2,
} from 'lucide-react'
import { api, type Document } from '../../api'
import {
  useAlternativeCandidates,
  type AlternativeCandidate,
} from '../../alternativeDrafts'
import { shortRevision } from '../../evidenceCitation'
import { RevisionMergeView } from '../RevisionMergeView'
import { ModalDialog } from '../ui/ModalDialog'
import { StateMessage } from '../ui/StateMessage'

export interface AlternativeDraftsModalProps {
  document: Document
  open: boolean
  onClose: () => void
  onDocumentUpdated?: (updated: Document) => void
}

export function AlternativeDraftsModal({
  document,
  open,
  onClose,
  onDocumentUpdated,
}: AlternativeDraftsModalProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { candidates, registerCandidate, removeCandidate } = useAlternativeCandidates(
    document.document_id,
  )

  const [newConclusionNote, setNewConclusionNote] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [comparingCandidateId, setComparingCandidateId] = useState<string | null>(null)
  const [applyingCandidateId, setApplyingCandidateId] = useState<string | null>(null)
  const [appliedSuccess, setAppliedSuccess] = useState<string | null>(null)

  const handleCreateCandidate = async (e: React.FormEvent) => {
    e.preventDefault()
    setCreating(true)
    setCreateError(null)
    try {
      const note = newConclusionNote.trim()
      const candidateTitle = note
        ? `${document.title} (${note})`
        : `${document.title} (Alternative Conclusion)`

      const created = await api.createDocument(
        candidateTitle,
        undefined,
        document.content_type,
        document.content,
      )

      await registerCandidate({
        parentDocumentId: document.document_id,
        candidateDocumentId: created.document_id,
        baseRevisionId: document.current_revision_id,
        title: candidateTitle,
        conclusionNote: note || undefined,
      })

      setNewConclusionNote('')
      await queryClient.invalidateQueries({ queryKey: ['documents'] })
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  const handleApplyChanges = async (candidate: AlternativeCandidate, candidateContent: string) => {
    setApplyingCandidateId(candidate.candidateDocumentId)
    try {
      const updated = await api.updateDocument(
        document.document_id,
        candidateContent,
        document.current_revision_id,
      )
      onDocumentUpdated?.(updated)
      setAppliedSuccess(candidate.candidateDocumentId)
      setTimeout(() => setAppliedSuccess(null), 3000)
      await queryClient.invalidateQueries({ queryKey: ['document', document.document_id] })
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplyingCandidateId(null)
    }
  }

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title="Explore Alternative Conclusions"
      className="alternative-drafts-modal"
    >
      <div className="alternative-drafts-content">
        <p className="alternative-drafts-lead">
          Branch into a separate candidate draft using the same sources. Compare assumptions and
          arguments side by side, then bring selected changes back to the original draft.
        </p>

        {createError && (
          <StateMessage
            compact
            kind="error"
            title="Candidate operation failed"
            description={createError}
          />
        )}

        {appliedSuccess && (
          <StateMessage
            compact
            kind="success"
            title="Changes applied to original draft"
            description="The original document has been updated with the candidate conclusion as a new revision."
          />
        )}

        <form className="alternative-drafts-create-form" onSubmit={handleCreateCandidate}>
          <div className="candidate-input-wrap">
            <input
              type="text"
              placeholder="Hypothesis or focus (e.g. 'Smaller model is sufficient with quant')..."
              value={newConclusionNote}
              onChange={(e) => setNewConclusionNote(e.target.value)}
              aria-label="Alternative conclusion hypothesis"
              disabled={creating}
            />
            <button
              type="submit"
              className="candidate-create-btn"
              disabled={creating}
              aria-label="Create candidate draft"
            >
              <GitFork size="var(--icon-detail)" />
              <span>{creating ? 'Branching…' : 'Explore another conclusion'}</span>
            </button>
          </div>
        </form>

        <div className="alternative-candidates-section">
          <header className="candidates-list-header">
            <strong>Candidate drafts ({candidates.length})</strong>
          </header>

          {candidates.length === 0 ? (
            <div className="candidates-empty-state">
              <p>No alternative candidates created yet.</p>
              <small>Click &ldquo;Explore another conclusion&rdquo; above to branch this draft.</small>
            </div>
          ) : (
            <div className="candidates-list" role="feed" aria-label="Alternative candidate drafts">
              {candidates.map((candidate) => (
                <CandidateCard
                  key={candidate.id}
                  candidate={candidate}
                  parentDocument={document}
                  isComparing={comparingCandidateId === candidate.candidateDocumentId}
                  isApplying={applyingCandidateId === candidate.candidateDocumentId}
                  onToggleCompare={() =>
                    setComparingCandidateId((prev) =>
                      prev === candidate.candidateDocumentId ? null : candidate.candidateDocumentId,
                    )
                  }
                  onApply={(content) => void handleApplyChanges(candidate, content)}
                  onOpen={() => {
                    onClose()
                    void navigate({
                      to: '/documents/$documentId',
                      params: { documentId: candidate.candidateDocumentId },
                    })
                  }}
                  onRemove={() => void removeCandidate(candidate.candidateDocumentId)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </ModalDialog>
  )
}

function CandidateCard({
  candidate,
  parentDocument,
  isComparing,
  isApplying,
  onToggleCompare,
  onApply,
  onOpen,
  onRemove,
}: {
  candidate: AlternativeCandidate
  parentDocument: Document
  isComparing: boolean
  isApplying: boolean
  onToggleCompare: () => void
  onApply: (content: string) => void
  onOpen: () => void
  onRemove: () => void
}) {
  const candidateDocQuery = useQuery({
    queryKey: ['document', candidate.candidateDocumentId],
    queryFn: () => api.getDocument(candidate.candidateDocumentId),
    enabled: isComparing,
  })

  const candidateDoc = candidateDocQuery.data

  return (
    <article className="candidate-draft-card" aria-label={`Candidate ${candidate.title}`}>
      <header className="candidate-card-header">
        <div className="candidate-meta">
          <strong className="candidate-title">{candidate.title}</strong>
          <div className="candidate-chips">
            <span className="candidate-base-chip" title={`Branched from rev ${candidate.baseRevisionId}`}>
              Base rev: {shortRevision(candidate.baseRevisionId)}
            </span>
            {candidate.conclusionNote && (
              <span className="candidate-note-chip">{candidate.conclusionNote}</span>
            )}
          </div>
        </div>

        <div className="candidate-actions">
          <button
            type="button"
            className="secondary-action button-sm"
            onClick={onToggleCompare}
            aria-label="Compare assumptions and arguments"
          >
            <ArrowLeftRight size="var(--icon-detail)" />
            <span>{isComparing ? 'Hide diff' : 'Compare diff'}</span>
            {isComparing ? <ChevronUp size="var(--icon-detail)" /> : <ChevronDown size="var(--icon-detail)" />}
          </button>

          <button
            type="button"
            className="secondary-action button-sm"
            onClick={onOpen}
            title="Open candidate in editor"
            aria-label="Open candidate"
          >
            <ExternalLink size="var(--icon-detail)" />
            <span>Open</span>
          </button>

          <button
            type="button"
            className="icon-button-sm"
            onClick={onRemove}
            title="Remove candidate from list"
            aria-label="Discard candidate"
          >
            <Trash2 size="var(--icon-detail)" />
          </button>
        </div>
      </header>

      {isComparing && (
        <div className="candidate-compare-pane">
          {candidateDocQuery.isLoading ? (
            <p className="candidate-loading-diff">Loading candidate document…</p>
          ) : candidateDoc ? (
            <>
              <div className="candidate-diff-header">
                <span className="diff-legend">
                  Left: <strong>Original ({shortRevision(parentDocument.current_revision_id)})</strong> &middot; Right:{' '}
                  <strong>Candidate conclusion</strong>
                </span>
                <button
                  type="button"
                  className="candidate-apply-btn"
                  disabled={isApplying}
                  onClick={() => onApply(candidateDoc.content)}
                  aria-label="Bring selected changes back to original"
                >
                  <Check size="var(--icon-detail)" />
                  <span>{isApplying ? 'Applying…' : 'Bring changes to original'}</span>
                </button>
              </div>
              <div className="candidate-diff-wrap">
                <RevisionMergeView
                  original={parentDocument.content}
                  modified={candidateDoc.content}
                />
              </div>
            </>
          ) : (
            <p className="candidate-error-diff">Could not load candidate document.</p>
          )}
        </div>
      )}
    </article>
  )
}
