import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ExternalLink,
  GitCompare,
  MessageSquare,
  Trash2,
  X,
} from 'lucide-react'
import { api, type Document, type DocumentSummary } from '../../api'
import { announceCitationNavigation } from '../../citationNavigation'
import { citationHref } from '../../citationNavigation'
import { chatNavigationState } from '../../chatNavigation'
import { useDocumentSessions } from '../../documentSessions'
import { itemToEvidenceReference, type EvidenceItem } from '../../evidenceCitation'
import { shortRevision } from '../../evidenceCitation'
import { useTheme } from '../../theme'
import { useWorkspaceEvidence } from '../../workspaceEvidenceState'
import { SourceVersionComparisonModal } from './SourceVersionComparisonModal'
import { ClaimMatrixView } from './ClaimMatrixView'
import { ModalDialog } from '../ui/ModalDialog'
import { StateMessage } from '../ui/StateMessage'

export function WorkspaceEvidenceRail({ document }: { document?: Document | null }) {
  const navigate = useNavigate()
  const sessions = useDocumentSessions()
  const { updatePreferences } = useTheme()
  const { evidence, error, retry, removeEvidence, updateEvidence, replaceEvidenceRevision, clearEvidence } =
    useWorkspaceEvidence()
  const documentsQuery = useQuery({ queryKey: ['documents', 'all'], queryFn: api.listDocuments })

  const [viewMode, setViewMode] = useState<'list' | 'matrix'>('list')
  const [filterQuery, setFilterQuery] = useState('')
  const [comparingPair, setComparingPair] = useState<[EvidenceItem, EvidenceItem] | null>(null)
  const [comparingWithId, setComparingWithId] = useState<string | null>(null)
  const [inspectingChangeItem, setInspectingChangeItem] = useState<EvidenceItem | null>(null)

  const activeDraftId = document?.content_type !== 'application/pdf' ? (document?.document_id ?? '') : ''
  const availableDrafts = (documentsQuery.data ?? []).filter(
    (candidate) => candidate.content_type !== 'application/pdf',
  )

  const filteredEvidence = evidence.filter((item) => {
    if (!filterQuery.trim()) return true
    const q = filterQuery.toLowerCase()
    return (
      item.selectedText.toLowerCase().includes(q) ||
      item.sourceTitle.toLowerCase().includes(q) ||
      (item.claim && item.claim.toLowerCase().includes(q)) ||
      (item.note && item.note.toLowerCase().includes(q))
    )
  })

  const openSource = (item: EvidenceItem) => {
    const target = {
      documentId: item.sourceDocumentId,
      revisionId: item.pinnedRevisionId,
      pageNumber: item.pageNumber ?? undefined,
      annotationId: item.annotationId ?? undefined,
      title: item.sourceTitle,
      textLocator: item.textLocator,
    }
    announceCitationNavigation(target)
    void navigate({
      href: citationHref(target),
    })
  }

  const askInChat = (item: EvidenceItem) => {
    updatePreferences({ rightVisible: true, rightTab: 'chat' })
    void navigate({
      to: '/chat',
      search: {
        document: item.sourceDocumentId,
        revision: item.pinnedRevisionId,
        returnTo: `/documents/${item.sourceDocumentId}`,
      },
      state: chatNavigationState(item.selectedText, {
        pageNumber: item.pageNumber,
        annotationId: item.annotationId,
      }),
    })
  }

  const handleStartCompare = (item: EvidenceItem) => {
    if (comparingWithId === null) {
      setComparingWithId(item.id)
    } else if (comparingWithId === item.id) {
      setComparingWithId(null)
    } else {
      const first = evidence.find((e) => e.id === comparingWithId)
      if (first) {
        setComparingPair([first, item])
      }
      setComparingWithId(null)
    }
  }

  return (
    <section className="workspace-evidence-rail" aria-label="Workspace evidence">
      <header className="evidence-rail-header">
        <div>
          <p className="eyebrow">Evidence</p>
          <strong>Workspace evidence</strong>
        </div>
        <div className="evidence-rail-meta">
          <div className="evidence-view-toggle" role="group" aria-label="Evidence display mode">
            <button
              type="button"
              className={`evidence-view-btn ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => setViewMode('list')}
              aria-label="List view"
            >
              List
            </button>
            <button
              type="button"
              className={`evidence-view-btn ${viewMode === 'matrix' ? 'active' : ''}`}
              onClick={() => setViewMode('matrix')}
              aria-label="Claim matrix view"
            >
              Matrix
            </button>
          </div>
          <span className="scope-badge">{evidence.length} kept</span>
          {evidence.length > 0 && (
            <button
              type="button"
              className="icon-button-sm"
              title="Clear all kept evidence"
              aria-label="Clear all kept evidence"
              onClick={() =>
                void clearEvidence().catch(() => {
                  /* Store displays persistence failure. */
                })
              }
            >
              <Trash2 size="var(--icon-detail)" />
            </button>
          )}
        </div>
      </header>
      {error && (
        <StateMessage
          compact
          kind="error"
          title="Evidence storage failed"
          description={error}
          action={
            <button type="button" className="secondary-action" onClick={retry}>
              Retry evidence storage
            </button>
          }
        />
      )}

      {viewMode === 'matrix' ? (
        <ClaimMatrixView
          evidence={evidence}
          onOpenPassage={openSource}
          onUpdateClassification={(id, status) => void updateEvidence(id, { claimClassification: status })}
        />
      ) : (
        <>
          {evidence.length > 3 && (
            <div className="evidence-filter-bar">
              <input
                type="search"
                aria-label="Filter evidence"
                placeholder="Search kept evidence…"
                value={filterQuery}
                onChange={(event) => setFilterQuery(event.target.value)}
              />
            </div>
          )}

          {comparingWithId && (
            <div className="evidence-compare-prompt" role="status">
              <span>Select another excerpt below to compare side by side.</span>
              <button type="button" className="secondary-action" onClick={() => setComparingWithId(null)}>
                Cancel
              </button>
            </div>
          )}

          {comparingPair && (
            <ExcerptComparisonModal pair={comparingPair} onClose={() => setComparingPair(null)} />
          )}

          {inspectingChangeItem && (
            <SourceVersionComparisonModal
              item={inspectingChangeItem}
              requirePassageRemap
              onClose={() => setInspectingChangeItem(null)}
              onUpdateRevision={async (newRevisionId, content) => {
                await replaceEvidenceRevision(inspectingChangeItem.id, newRevisionId, content)
                setInspectingChangeItem(null)
              }}
            />
          )}

          {filteredEvidence.length === 0 ? (
            error ? null : (
              <StateMessage
                compact
                kind="empty"
                title={evidence.length === 0 ? 'No evidence kept yet' : 'No evidence matches your search'}
                description={
                  evidence.length === 0
                    ? 'Select a passage in a PDF, imported article, or document and choose Keep as evidence.'
                    : undefined
                }
              />
            )
          ) : (
            <div className="evidence-items-list" role="feed" aria-label="Kept evidence list">
              {filteredEvidence.map((item) => (
                <EvidenceCard
                  key={item.id}
                  item={item}
                  activeDraftId={activeDraftId}
                  availableDrafts={availableDrafts}
                  isComparingTarget={comparingWithId === item.id}
                  onInsert={async (targetDraftId) => {
                    const [inserted] = await Promise.all([
                      sessions.insertEvidence(targetDraftId, itemToEvidenceReference(item)),
                      navigate({ to: '/documents/$documentId', params: { documentId: targetDraftId } }),
                    ])
                    updatePreferences({ rightVisible: !matchMedia('(max-width: 900px)').matches })
                    if (!inserted)
                      throw new Error('The destination editor did not insert the passage. Try again.')
                  }}
                  onOpenSource={() => openSource(item)}
                  onAskInChat={() => askInChat(item)}
                  onCompare={() => handleStartCompare(item)}
                  onInspectSourceChange={() => setInspectingChangeItem(item)}
                  onUpdateClaim={async (claim, targetDraftId) => {
                    if (!targetDraftId)
                      throw new Error('Choose a destination draft before attaching a claim.')
                    const existing = sessions.getSession(targetDraftId)
                    if (existing.content === undefined || existing.draftPersistenceOperation === 'read')
                      await sessions.initializeDocument(await api.getDocument(targetDraftId))
                    const target = sessions.getSession(targetDraftId)
                    if (target.draftPersistenceState === 'failed')
                      throw new Error('Recover the destination draft before attaching a claim.')
                    return updateEvidence(item.id, {
                      claim,
                      claimTarget: {
                        documentId: targetDraftId,
                        anchor: target.viewState?.anchor ?? 0,
                        head: target.viewState?.head ?? 0,
                        revisionId: target.baseRevisionId,
                      },
                    })
                  }}
                  onUpdateNote={(note) => updateEvidence(item.id, { note })}
                  onRemove={() => removeEvidence(item.id)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}

function EvidenceCard({
  item,
  activeDraftId,
  availableDrafts,
  isComparingTarget,
  onInsert,
  onOpenSource,
  onAskInChat,
  onCompare,
  onInspectSourceChange,
  onUpdateClaim,
  onUpdateNote,
  onRemove,
}: {
  item: EvidenceItem
  activeDraftId: string
  availableDrafts: DocumentSummary[]
  isComparingTarget: boolean
  onInsert: (targetDraftId: string) => Promise<void>
  onOpenSource: () => void
  onAskInChat: () => void
  onCompare: () => void
  onInspectSourceChange: () => void
  onUpdateClaim: (claim: string, targetDraftId: string) => Promise<void>
  onUpdateNote: (note: string) => Promise<void>
  onRemove: () => Promise<void>
}) {
  const [insertedTarget, setInsertedTarget] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [inserting, setInserting] = useState(false)
  const [editingClaim, setEditingClaim] = useState(false)
  const [claimText, setClaimText] = useState(item.claim ?? '')
  const [editingNote, setEditingNote] = useState(false)
  const [noteText, setNoteText] = useState(item.note ?? '')
  const [targetDraft, setTargetDraft] = useState('')
  const destination = activeDraftId || targetDraft
  const inserted = insertedTarget === destination
  const commitMetadata = async (action: () => Promise<void>, done?: () => void) => {
    try {
      await action()
      setActionError(null)
      done?.()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  // Query source document to see if head revision has changed
  const sourceDocQuery = useQuery({
    queryKey: ['document', item.sourceDocumentId],
    queryFn: () => api.getDocument(item.sourceDocumentId),
    enabled: Boolean(item.pinnedRevisionId),
  })

  const sourceDoc = sourceDocQuery.data
  const sourceChanged =
    Boolean(sourceDoc && item.pinnedRevisionId) && sourceDoc?.current_revision_id !== item.pinnedRevisionId

  const handleInsert = async () => {
    const draftId = destination
    if (!draftId) return
    setInserting(true)
    await commitMetadata(
      () => onInsert(draftId),
      () => setInsertedTarget(draftId),
    )
    setInserting(false)
  }

  return (
    <article
      className={`evidence-card ${isComparingTarget ? 'comparing-selected' : ''}`}
      aria-label={`Evidence from ${item.sourceTitle}`}
    >
      <header className="evidence-card-header">
        <div className="evidence-card-source">
          <button
            type="button"
            className="evidence-source-link"
            title="Open exact source document"
            onClick={onOpenSource}
          >
            <strong>{item.sourceTitle}</strong>
            <ExternalLink size="var(--icon-detail)" />
          </button>
          <div className="evidence-card-badges">
            {item.pageNumber && <span className="evidence-badge">p. {item.pageNumber}</span>}
            {item.pinnedRevisionId && (
              <span className="evidence-badge" title={`Pinned revision ${item.pinnedRevisionId}`}>
                rev {shortRevision(item.pinnedRevisionId)}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          className="icon-button-sm"
          title="Remove evidence"
          aria-label="Remove evidence"
          onClick={() => void commitMetadata(onRemove)}
        >
          <X size="var(--icon-detail)" />
        </button>
      </header>
      {actionError && (
        <StateMessage compact kind="error" title="Evidence action failed" description={actionError} />
      )}

      {sourceChanged && (
        <div className="evidence-source-changed-alert" role="alert">
          <AlertTriangle size="var(--icon-inline)" />
          <div>
            <strong>Source changed</strong>
            <small>
              Pinned {shortRevision(item.pinnedRevisionId)} &middot; Head{' '}
              {shortRevision(sourceDoc?.current_revision_id)}
            </small>
          </div>
          <button
            type="button"
            className="secondary-action button-sm"
            aria-label="Compare source versions"
            onClick={onInspectSourceChange}
          >
            Compare
          </button>
        </div>
      )}

      <blockquote className="evidence-card-quote">
        <p>{item.selectedText}</p>
      </blockquote>

      {item.claim || editingClaim ? (
        <div className="evidence-card-claim">
          <span className="evidence-meta-label">Claim:</span>
          {editingClaim ? (
            <div className="evidence-meta-edit">
              <input
                aria-label="Claim statement"
                value={claimText}
                placeholder="Attach a claim or conclusion…"
                onChange={(e) => setClaimText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void commitMetadata(
                      () => onUpdateClaim(claimText, destination),
                      () => setEditingClaim(false),
                    )
                  }
                }}
              />
              <button
                type="button"
                className="secondary-action button-sm"
                onClick={() => {
                  void commitMetadata(
                    () => onUpdateClaim(claimText, destination),
                    () => setEditingClaim(false),
                  )
                }}
              >
                Save
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="evidence-meta-text"
              onClick={() => setEditingClaim(true)}
              title="Click to edit claim"
            >
              {item.claim}
            </button>
          )}
        </div>
      ) : (
        <button type="button" className="evidence-inline-add" onClick={() => setEditingClaim(true)}>
          + Attach to a claim
        </button>
      )}

      {item.note || editingNote ? (
        <div className="evidence-card-note">
          <span className="evidence-meta-label">Note:</span>
          {editingNote ? (
            <div className="evidence-meta-edit">
              <input
                aria-label="Evidence note"
                value={noteText}
                placeholder="Add contextual note…"
                onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void commitMetadata(
                      () => onUpdateNote(noteText),
                      () => setEditingNote(false),
                    )
                  }
                }}
              />
              <button
                type="button"
                className="secondary-action button-sm"
                onClick={() => {
                  void commitMetadata(
                    () => onUpdateNote(noteText),
                    () => setEditingNote(false),
                  )
                }}
              >
                Save
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="evidence-meta-text"
              onClick={() => setEditingNote(true)}
              title="Click to edit note"
            >
              {item.note}
            </button>
          )}
        </div>
      ) : (
        <button type="button" className="evidence-inline-add" onClick={() => setEditingNote(true)}>
          + Add note
        </button>
      )}

      <div className="evidence-card-actions">
        {!activeDraftId && (
          <select
            className="evidence-draft-select"
            aria-label="Destination draft"
            value={targetDraft}
            onChange={(e) => setTargetDraft(e.target.value)}
          >
            <option value="">Choose a destination draft…</option>
            {availableDrafts.map((d) => (
              <option key={d.document_id} value={d.document_id}>
                {d.path ?? d.title}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="panel-button"
          disabled={!destination || inserting}
          onClick={() => void handleInsert()}
        >
          {inserted ? <Check size="var(--icon-inline)" /> : <ArrowRight size="var(--icon-inline)" />}
          {inserted ? 'Inserted at cursor' : inserting ? 'Opening destination…' : 'Insert at cursor'}
        </button>

        <div className="evidence-card-secondary-row">
          <button
            type="button"
            className="secondary-action button-sm"
            title="Ask about this excerpt in chat"
            onClick={onAskInChat}
          >
            <MessageSquare size="var(--icon-detail)" />
            Ask
          </button>
          <button
            type="button"
            className={`secondary-action button-sm ${isComparingTarget ? 'active' : ''}`}
            title="Compare with another excerpt"
            onClick={onCompare}
          >
            <GitCompare size="var(--icon-detail)" />
            Compare
          </button>
          <button
            type="button"
            className="secondary-action button-sm"
            title="Open exact source document"
            onClick={onOpenSource}
          >
            <ExternalLink size="var(--icon-detail)" />
            Source
          </button>
        </div>
      </div>
    </article>
  )
}

function ExcerptComparisonModal({
  pair,
  onClose,
}: {
  pair: [EvidenceItem, EvidenceItem]
  onClose: () => void
}) {
  const [a, b] = pair
  return (
    <ModalDialog className="evidence-modal-dialog" ariaLabel="Compare evidence excerpts" onClose={onClose}>
      <div className="evidence-modal-content">
        <header className="evidence-modal-header">
          <strong>Compare excerpts</strong>
          <button type="button" className="icon-button-sm" onClick={onClose} aria-label="Close comparison">
            <X size="var(--icon-control)" />
          </button>
        </header>
        <div className="evidence-comparison-columns">
          <div className="evidence-comparison-pane">
            <p className="eyebrow">{a.sourceTitle}</p>
            {a.claim && (
              <p className="comparison-claim">
                <strong>Claim:</strong> {a.claim}
              </p>
            )}
            <blockquote className="evidence-card-quote">
              <p>{a.selectedText}</p>
            </blockquote>
            {a.note && <small className="small-muted">Note: {a.note}</small>}
          </div>
          <div className="evidence-comparison-pane">
            <p className="eyebrow">{b.sourceTitle}</p>
            {b.claim && (
              <p className="comparison-claim">
                <strong>Claim:</strong> {b.claim}
              </p>
            )}
            <blockquote className="evidence-card-quote">
              <p>{b.selectedText}</p>
            </blockquote>
            {b.note && <small className="small-muted">Note: {b.note}</small>}
          </div>
        </div>
        <footer className="evidence-modal-footer">
          <button type="button" className="secondary-action" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </ModalDialog>
  )
}
