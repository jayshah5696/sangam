import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  AlertTriangle,
  ArrowRight,
  BookmarkCheck,
  Check,
  ExternalLink,
  GitCompare,
  MessageSquare,
  Trash2,
  X,
} from 'lucide-react'
import { api, type Document } from '../../api'
import { announceCitationNavigation } from '../../citationNavigation'
import { useDocumentSessions } from '../../documentSessions'
import {
  evidenceCitationMarkdown,
  itemToEvidenceReference,
  type EvidenceItem,
} from '../../evidenceCitation'
import { shortRevision } from '../../evidenceCitation'
import { useTheme } from '../../theme'
import { useWorkspaceEvidence } from '../../workspaceEvidenceState'
import { MarkdownPreview } from '../MarkdownPreview'

export function WorkspaceEvidenceRail({ document }: { document?: Document | null }) {
  const navigate = useNavigate()
  const sessions = useDocumentSessions()
  const { updatePreferences } = useTheme()
  const { evidence, removeEvidence, updateEvidence, replaceEvidenceRevision, clearEvidence } =
    useWorkspaceEvidence()
  const documentsQuery = useQuery({ queryKey: ['documents'], queryFn: api.listDocuments })

  const [filterQuery, setFilterQuery] = useState('')
  const [comparingPair, setComparingPair] = useState<[EvidenceItem, EvidenceItem] | null>(null)
  const [comparingWithId, setComparingWithId] = useState<string | null>(null)
  const [inspectingChangeItem, setInspectingChangeItem] = useState<EvidenceItem | null>(null)

  const activeDraftId = document?.document_id ?? ''
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
    const params = new URLSearchParams()
    if (item.pinnedRevisionId) params.set('revision', item.pinnedRevisionId)
    if (item.pageNumber) params.set('page', String(item.pageNumber))
    if (item.annotationId) params.set('annotation', item.annotationId)

    const query = params.size ? `?${params.toString()}` : ''
    announceCitationNavigation({
      documentId: item.sourceDocumentId,
      revisionId: item.pinnedRevisionId,
      pageNumber: item.pageNumber ?? undefined,
      annotationId: item.annotationId ?? undefined,
      title: item.sourceTitle,
    })
    void navigate({
      to: `/documents/${item.sourceDocumentId}${query}`,
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
          <span className="scope-badge">{evidence.length} kept</span>
          {evidence.length > 0 && (
            <button
              type="button"
              className="ghost-button icon-button-sm"
              title="Clear all kept evidence"
              aria-label="Clear all kept evidence"
              onClick={clearEvidence}
            >
              <Trash2 size="var(--icon-detail)" />
            </button>
          )}
        </div>
      </header>

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
          onClose={() => setInspectingChangeItem(null)}
          onUpdateRevision={(newRevisionId) => {
            replaceEvidenceRevision(inspectingChangeItem.id, newRevisionId)
            setInspectingChangeItem(null)
          }}
        />
      )}

      {filteredEvidence.length === 0 ? (
        <div className="empty-evidence-message">
          <BookmarkCheck size="var(--icon-section)" />
          <p>
            {evidence.length === 0
              ? 'No evidence kept yet. Select any text passage in a PDF, imported article, or document and choose Keep as evidence.'
              : 'No evidence matches your search.'}
          </p>
        </div>
      ) : (
        <div className="evidence-items-list" role="feed" aria-label="Kept evidence list">
          {filteredEvidence.map((item) => (
            <EvidenceCard
              key={item.id}
              item={item}
              activeDraftId={activeDraftId}
              availableDrafts={availableDrafts}
              isComparingTarget={comparingWithId === item.id}
              onInsert={(targetDraftId) => {
                const markdown = evidenceCitationMarkdown(itemToEvidenceReference(item))
                sessions.insertText(targetDraftId, markdown)
              }}
              onOpenSource={() => openSource(item)}
              onAskInChat={() => askInChat(item)}
              onCompare={() => handleStartCompare(item)}
              onInspectSourceChange={() => setInspectingChangeItem(item)}
              onUpdateClaim={(claim) => updateEvidence(item.id, { claim })}
              onUpdateNote={(note) => updateEvidence(item.id, { note })}
              onRemove={() => removeEvidence(item.id)}
            />
          ))}
        </div>
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
  availableDrafts: Document[]
  isComparingTarget: boolean
  onInsert: (targetDraftId: string) => void
  onOpenSource: () => void
  onAskInChat: () => void
  onCompare: () => void
  onInspectSourceChange: () => void
  onUpdateClaim: (claim: string) => void
  onUpdateNote: (note: string) => void
  onRemove: () => void
}) {
  const [inserted, setInserted] = useState(false)
  const [editingClaim, setEditingClaim] = useState(false)
  const [claimText, setClaimText] = useState(item.claim ?? '')
  const [editingNote, setEditingNote] = useState(false)
  const [noteText, setNoteText] = useState(item.note ?? '')
  const [targetDraft, setTargetDraft] = useState(
    activeDraftId || (availableDrafts[0]?.document_id ?? ''),
  )

  // Query source document to see if head revision has changed
  const sourceDocQuery = useQuery({
    queryKey: ['document', item.sourceDocumentId],
    queryFn: () => api.getDocument(item.sourceDocumentId),
    enabled: Boolean(item.pinnedRevisionId),
  })

  const sourceDoc = sourceDocQuery.data
  const sourceChanged =
    Boolean(sourceDoc && item.pinnedRevisionId) &&
    sourceDoc?.current_revision_id !== item.pinnedRevisionId

  const handleInsert = () => {
    const draftId = targetDraft || activeDraftId
    if (!draftId) return
    onInsert(draftId)
    setInserted(true)
    setTimeout(() => setInserted(false), 2000)
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
          className="ghost-button icon-button-sm"
          title="Remove evidence"
          aria-label="Remove evidence"
          onClick={onRemove}
        >
          <X size="var(--icon-detail)" />
        </button>
      </header>

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
                    onUpdateClaim(claimText)
                    setEditingClaim(false)
                  }
                }}
              />
              <button
                type="button"
                className="secondary-action button-sm"
                onClick={() => {
                  onUpdateClaim(claimText)
                  setEditingClaim(false)
                }}
              >
                Save
              </button>
            </div>
          ) : (
            <p
              className="evidence-meta-text"
              onClick={() => setEditingClaim(true)}
              title="Click to edit claim"
            >
              {item.claim}
            </p>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="evidence-inline-add"
          onClick={() => setEditingClaim(true)}
        >
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
                    onUpdateNote(noteText)
                    setEditingNote(false)
                  }
                }}
              />
              <button
                type="button"
                className="secondary-action button-sm"
                onClick={() => {
                  onUpdateNote(noteText)
                  setEditingNote(false)
                }}
              >
                Save
              </button>
            </div>
          ) : (
            <p
              className="evidence-meta-text"
              onClick={() => setEditingNote(true)}
              title="Click to edit note"
            >
              {item.note}
            </p>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="evidence-inline-add"
          onClick={() => setEditingNote(true)}
        >
          + Add note
        </button>
      )}

      <div className="evidence-card-actions">
        {availableDrafts.length > 1 && !activeDraftId && (
          <select
            className="evidence-draft-select"
            aria-label="Destination draft"
            value={targetDraft}
            onChange={(e) => setTargetDraft(e.target.value)}
          >
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
          disabled={!targetDraft && !activeDraftId}
          onClick={handleInsert}
        >
          {inserted ? <Check size="var(--icon-inline)" /> : <ArrowRight size="var(--icon-inline)" />}
          {inserted ? 'Inserted at cursor' : 'Insert at cursor'}
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
    <div className="evidence-modal-backdrop" role="dialog" aria-modal="true" aria-label="Compare evidence excerpts">
      <div className="evidence-modal-content">
        <header className="evidence-modal-header">
          <strong>Compare excerpts</strong>
          <button type="button" className="ghost-button icon-button-sm" onClick={onClose} aria-label="Close comparison">
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
    </div>
  )
}

function SourceVersionComparisonModal({
  item,
  onClose,
  onUpdateRevision,
}: {
  item: EvidenceItem
  onClose: () => void
  onUpdateRevision: (newRevisionId: string) => void
}) {
  const historyQuery = useQuery({
    queryKey: ['history', item.sourceDocumentId],
    queryFn: () => api.history(item.sourceDocumentId),
    enabled: Boolean(item.pinnedRevisionId),
  })

  const docQuery = useQuery({
    queryKey: ['document', item.sourceDocumentId],
    queryFn: () => api.getDocument(item.sourceDocumentId),
  })

  const history = historyQuery.data ?? []
  const pinnedRev = history.find((r) => r.revision_id === item.pinnedRevisionId)
  const currentDoc = docQuery.data
  const currentRevId = currentDoc?.current_revision_id

  return (
    <div
      className="evidence-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Compare source versions"
    >
      <div className="evidence-modal-content wide">
        <header className="evidence-modal-header">
          <div>
            <strong>Compare source versions: {item.sourceTitle}</strong>
            <p className="small-muted">
              Pinned: {shortRevision(item.pinnedRevisionId)} &middot; Current head:{' '}
              {shortRevision(currentRevId)}
            </p>
          </div>
          <button
            type="button"
            className="ghost-button icon-button-sm"
            onClick={onClose}
            aria-label="Close comparison"
          >
            <X size="var(--icon-control)" />
          </button>
        </header>

        <div className="evidence-version-comparison-body">
          <div className="evidence-version-column">
            <h4>Pinned revision ({shortRevision(item.pinnedRevisionId)})</h4>
            <div className="comparison-preview-container">
              {pinnedRev ? (
                <MarkdownPreview content={pinnedRev.content} />
              ) : (
                <p className="small-muted">Pinned revision snapshot loading…</p>
              )}
            </div>
          </div>
          <div className="evidence-version-column">
            <h4>Current head revision ({shortRevision(currentRevId)})</h4>
            <div className="comparison-preview-container">
              {currentDoc ? (
                <MarkdownPreview content={currentDoc.content} />
              ) : (
                <p className="small-muted">Current document content loading…</p>
              )}
            </div>
          </div>
        </div>

        <footer className="evidence-modal-footer">
          <button type="button" className="secondary-action" onClick={onClose}>
            Keep original pinned reference
          </button>
          {currentRevId && (
            <button
              type="button"
              className="panel-button"
              onClick={() => onUpdateRevision(currentRevId)}
            >
              Update to current head revision
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
