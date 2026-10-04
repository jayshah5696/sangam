import { useEffect, useId, useState } from 'react'
import { ExternalLink, FileText, Search, X } from 'lucide-react'
import type { PublishedEvidenceItem } from '../../api'

export interface PublicationEvidenceDrawerProps {
  evidence: PublishedEvidenceItem[]
  isOpen: boolean
  onClose: () => void
  onHighlightPassage?: (text: string) => void
}

function shortRevision(rev?: string | null): string {
  if (!rev) return ''
  return rev.slice(0, 8)
}

export function PublicationEvidenceDrawer({
  evidence,
  isOpen,
  onClose,
  onHighlightPassage,
}: PublicationEvidenceDrawerProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [activeItemId, setActiveItemId] = useState<string | null>(null)
  const titleId = useId()

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && isOpen) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const filteredEvidence = evidence.filter((item) => {
    if (!searchQuery.trim()) return true
    const q = searchQuery.toLowerCase()
    return (
      item.selected_text.toLowerCase().includes(q) ||
      item.source_title.toLowerCase().includes(q) ||
      (item.claim && item.claim.toLowerCase().includes(q)) ||
      (item.note && item.note.toLowerCase().includes(q))
    )
  })

  return (
    <aside
      className="publication-evidence-drawer"
      id="publication-evidence-drawer"
      role="complementary"
      aria-labelledby={titleId}
    >
      <div className="drawer-header">
        <div className="drawer-title-row">
          <div className="drawer-title-group">
            <FileText size="var(--icon-control)" className="drawer-icon" aria-hidden="true" />
            <h2 id={titleId} className="drawer-title">
              Evidence Drawer
            </h2>
            <span className="drawer-count-badge" aria-label={`${evidence.length} evidence items`}>
              {evidence.length}
            </span>
          </div>
          <button
            type="button"
            className="drawer-close-button"
            onClick={onClose}
            aria-label="Close evidence drawer"
          >
            <X size="var(--icon-control)" aria-hidden="true" />
          </button>
        </div>
        <p className="drawer-description">
          Passages and citations supporting claims in this published article.
        </p>

        {evidence.length > 2 && (
          <div className="drawer-search-row">
            <Search size="var(--icon-detail)" className="drawer-search-icon" aria-hidden="true" />
            <input
              type="search"
              className="drawer-search-input"
              placeholder="Filter claims or excerpts…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Filter evidence"
            />
          </div>
        )}
      </div>

      <div className="drawer-body" role="list" aria-label="Published evidence list">
        {filteredEvidence.length === 0 ? (
          <div className="drawer-empty-state">
            <p className="small-muted">No matching evidence found.</p>
          </div>
        ) : (
          filteredEvidence.map((item) => {
            const isSelected = activeItemId === item.id
            return (
              <article
                key={item.id}
                role="listitem"
                className={`drawer-evidence-card ${isSelected ? 'selected' : ''}`}
                onClick={() => setActiveItemId(item.id)}
              >
                <div className="card-source-header">
                  <div className="card-source-title" title={item.source_title}>
                    <FileText size="var(--icon-detail)" aria-hidden="true" />
                    <span>{item.source_title}</span>
                  </div>
                  <div className="card-badges">
                    {item.page_number && <span className="source-page-badge">Page {item.page_number}</span>}
                    {item.pinned_revision_id && (
                      <span className="source-revision-badge">
                        rev · {shortRevision(item.pinned_revision_id)}
                      </span>
                    )}
                    {item.source_is_public && item.source_slug ? (
                      <a
                        href={`/p/${item.source_slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="source-public-link"
                        title="Open cited public publication"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <ExternalLink size="var(--icon-detail)" aria-hidden="true" />
                        <span>Public source</span>
                      </a>
                    ) : (
                      <span
                        className="source-private-badge"
                        title="Private workspace source (content pinned at publication time)"
                      >
                        Workspace source
                      </span>
                    )}
                  </div>
                </div>

                {item.claim && (
                  <div className="card-claim">
                    <span className="claim-label">Claim:</span>
                    <span className="claim-text">{item.claim}</span>
                  </div>
                )}

                <blockquote className="card-quote">
                  <p>{item.selected_text}</p>
                </blockquote>

                {item.note && (
                  <div className="card-note">
                    <span className="note-label">Note:</span>
                    <span className="note-text">{item.note}</span>
                  </div>
                )}

                {onHighlightPassage && (
                  <div className="card-actions">
                    <button
                      type="button"
                      className="card-locate-button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setActiveItemId(item.id)
                        onHighlightPassage(item.selected_text)
                      }}
                    >
                      Find in text
                    </button>
                  </div>
                )}
              </article>
            )
          })
        )}
      </div>
    </aside>
  )
}
