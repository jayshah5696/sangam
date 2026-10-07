import { useMemo, useState } from 'react'
import { Check, Copy, ExternalLink, Filter, Plus, X } from 'lucide-react'
import {
  type ClaimClassification,
  type EvidenceItem,
  shortRevision,
} from '../../evidenceCitation'
import { ModalDialog } from '../ui/ModalDialog'

const CLASSIFICATIONS: ClaimClassification[] = [
  'Supports',
  'Challenges',
  'Not checked',
  'Assumption',
  'No evidence',
]

export interface ClaimMatrixViewProps {
  evidence: EvidenceItem[]
  onOpenPassage: (item: EvidenceItem) => void
  onUpdateClassification: (id: string, classification: ClaimClassification) => void
  onUpdateClaim?: (id: string, claim: string) => void
}

interface SourceColumn {
  documentId: string
  title: string
}

export function ClaimMatrixView({
  evidence,
  onOpenPassage,
  onUpdateClassification,
}: ClaimMatrixViewProps) {
  const [filterQuery, setFilterQuery] = useState('')
  const [customClaims, setCustomClaims] = useState<string[]>([])
  const [newClaimInput, setNewClaimInput] = useState('')
  const [copied, setCopied] = useState(false)
  const [activeCellItem, setActiveCellItem] = useState<EvidenceItem | null>(null)

  // Collect unique source documents
  const sources: SourceColumn[] = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of evidence) {
      if (!map.has(item.sourceDocumentId)) {
        map.set(item.sourceDocumentId, item.sourceTitle || 'Source')
      }
    }
    return Array.from(map.entries()).map(([documentId, title]) => ({
      documentId,
      title,
    }))
  }, [evidence])

  // Collect unique claims from evidence + custom additions
  const claims: string[] = useMemo(() => {
    const set = new Set<string>()
    for (const item of evidence) {
      const trimmed = item.claim?.trim()
      if (trimmed) set.add(trimmed)
    }
    for (const custom of customClaims) {
      if (custom.trim()) set.add(custom.trim())
    }
    return Array.from(set)
  }, [evidence, customClaims])

  // Filtered claims and sources
  const filteredClaims = useMemo(() => {
    if (!filterQuery.trim()) return claims
    const q = filterQuery.toLowerCase()
    return claims.filter((claim) => claim.toLowerCase().includes(q))
  }, [claims, filterQuery])

  // Map from `${claim}:${sourceDocumentId}` to EvidenceItem
  const cellMap = useMemo(() => {
    const map = new Map<string, EvidenceItem>()
    for (const item of evidence) {
      const claim = item.claim?.trim()
      if (claim) {
        map.set(`${claim}:${item.sourceDocumentId}`, item)
      }
    }
    return map
  }, [evidence])

  // Summary counts
  const statusCounts = useMemo(() => {
    const counts = {
      Supports: 0,
      Challenges: 0,
      'Not checked': 0,
      Assumption: 0,
      'No evidence': 0,
    } satisfies Record<ClaimClassification, number>
    for (const item of evidence) {
      const status = item.claimClassification ?? 'Supports'
      if (status in counts) {
        counts[status]++
      }
    }
    return counts
  }, [evidence])

  const handleAddClaim = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = newClaimInput.trim()
    if (!trimmed) return
    if (!customClaims.includes(trimmed)) {
      setCustomClaims((prev) => [...prev, trimmed])
    }
    setNewClaimInput('')
  }

  const handleCopyMarkdown = async () => {
    if (sources.length === 0 || claims.length === 0) return
    const headers = ['Claim', ...sources.map((s) => s.title)]
    const separator = headers.map(() => '---')
    const rows = claims.map((claim) => {
      const cells = sources.map((source) => {
        const item = cellMap.get(`${claim}:${source.documentId}`)
        return item?.claimClassification ?? 'Not checked'
      })
      return [claim, ...cells]
    })

    const markdown = [
      `| ${headers.join(' | ')} |`,
      `| ${separator.join(' | ')} |`,
      ...rows.map((row) => `| ${row.join(' | ')} |`),
    ].join('\n')

    try {
      await navigator.clipboard.writeText(markdown)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard failure ignored */
    }
  }

  const getBadgeClass = (status: ClaimClassification) => {
    switch (status) {
      case 'Supports':
        return 'status-supports'
      case 'Challenges':
        return 'status-challenges'
      case 'Assumption':
        return 'status-assumption'
      case 'No evidence':
        return 'status-no-evidence'
      default:
        return 'status-not-checked'
    }
  }

  return (
    <div className="claim-matrix-view" aria-label="Claim-versus-source matrix">
      <div className="claim-matrix-toolbar">
        <div className="claim-matrix-search">
          <Filter size="var(--icon-detail)" />
          <input
            type="text"
            placeholder="Filter claims or sources..."
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            aria-label="Filter claims or sources"
          />
          {filterQuery && (
            <button
              type="button"
              className="icon-button-sm"
              onClick={() => setFilterQuery('')}
              aria-label="Clear filter"
            >
              <X size="var(--icon-detail)" />
            </button>
          )}
        </div>

        <button
          type="button"
          className="claim-matrix-export-btn"
          onClick={() => void handleCopyMarkdown()}
          disabled={claims.length === 0 || sources.length === 0}
          title="Copy GFM matrix table to clipboard"
          aria-label="Copy markdown matrix"
        >
          {copied ? <Check size="var(--icon-detail)" /> : <Copy size="var(--icon-detail)" />}
          <span>{copied ? 'Copied!' : 'Copy table'}</span>
        </button>
      </div>

      <div className="claim-matrix-stats" aria-label="Claim stance counts">
        <span className="stat-pill status-supports">Supports: {statusCounts.Supports}</span>
        <span className="stat-pill status-challenges">Challenges: {statusCounts.Challenges}</span>
        <span className="stat-pill status-assumption">Assumption: {statusCounts.Assumption}</span>
        <span className="stat-pill status-no-evidence">No evidence: {statusCounts['No evidence']}</span>
      </div>

      <form className="claim-matrix-add-form" onSubmit={handleAddClaim}>
        <input
          type="text"
          placeholder="Add a new claim to evaluate..."
          value={newClaimInput}
          onChange={(e) => setNewClaimInput(e.target.value)}
          aria-label="New claim text"
        />
        <button
          type="submit"
          className="claim-matrix-add-btn"
          disabled={!newClaimInput.trim()}
          aria-label="Add claim"
        >
          <Plus size="var(--icon-detail)" />
          <span>Add Claim</span>
        </button>
      </form>

      {sources.length === 0 ? (
        <div className="claim-matrix-empty" role="status">
          <p>No sources found in kept evidence.</p>
          <small>Keep excerpts from workspace documents or PDFs to build the matrix.</small>
        </div>
      ) : filteredClaims.length === 0 ? (
        <div className="claim-matrix-empty" role="status">
          <p>No claims match the filter or none have been added yet.</p>
          <small>Assign a claim to an evidence excerpt or add one above.</small>
        </div>
      ) : (
        <div className="claim-matrix-table-wrap">
          <table className="claim-matrix-table" aria-label="Claims and supporting sources">
            <thead>
              <tr>
                <th scope="col" className="matrix-th-claim">
                  Claim
                </th>
                {sources.map((src) => (
                  <th key={src.documentId} scope="col" className="matrix-th-source" title={src.title}>
                    <span className="source-header-title">{src.title}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredClaims.map((claim) => (
                <tr key={claim}>
                  <td className="matrix-td-claim">
                    <strong>{claim}</strong>
                  </td>
                  {sources.map((src) => {
                    const item = cellMap.get(`${claim}:${src.documentId}`)
                    const classification: ClaimClassification = item?.claimClassification ?? 'Not checked'
                    return (
                      <td key={src.documentId} className="matrix-td-cell">
                        {item ? (
                          <button
                            type="button"
                            className={`claim-cell-badge ${getBadgeClass(classification)}`}
                            onClick={() => setActiveCellItem(item)}
                            title={`Click to inspect passage (${classification})`}
                            aria-label={`Claim: ${claim}, Source: ${src.title}, Status: ${classification}`}
                          >
                            {classification}
                          </button>
                        ) : (
                          <span
                            className="claim-cell-empty"
                            title="Not checked for this source"
                          >
                            Not checked
                          </span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeCellItem && (
        <ModalDialog
          open={Boolean(activeCellItem)}
          onClose={() => setActiveCellItem(null)}
          title="Evidence & Stance Details"
          className="claim-matrix-dialog"
        >
          <div className="claim-cell-modal-content">
            <div className="claim-modal-row">
              <span className="claim-modal-label">Claim</span>
              <p className="claim-modal-claim-text">{activeCellItem.claim || 'Unlabeled claim'}</p>
            </div>

            <div className="claim-modal-row">
              <span className="claim-modal-label">Source</span>
              <p className="claim-modal-source-meta">
                <strong>{activeCellItem.sourceTitle}</strong>
                {activeCellItem.pageNumber ? (
                  <span> (p. {activeCellItem.pageNumber})</span>
                ) : activeCellItem.pinnedRevisionId ? (
                  <span> (rev. {shortRevision(activeCellItem.pinnedRevisionId)})</span>
                ) : null}
              </p>
            </div>

            <div className="claim-modal-row">
              <span className="claim-modal-label">Classification Stance</span>
              <div className="claim-stance-selector" role="radiogroup" aria-label="Change classification stance">
                {CLASSIFICATIONS.map((status) => (
                  <button
                    key={status}
                    type="button"
                    className={`stance-btn ${getBadgeClass(status)} ${
                      (activeCellItem.claimClassification ?? 'Supports') === status ? 'active' : ''
                    }`}
                    onClick={() => {
                      onUpdateClassification(activeCellItem.id, status)
                      setActiveCellItem((prev) =>
                        prev ? { ...prev, claimClassification: status } : null,
                      )
                    }}
                  >
                    {status}
                  </button>
                ))}
              </div>
            </div>

            <div className="claim-modal-row">
              <span className="claim-modal-label">Verbatim Passage Excerpt</span>
              <blockquote className="claim-modal-passage">
                {activeCellItem.selectedText}
              </blockquote>
            </div>

            {activeCellItem.note && (
              <div className="claim-modal-row">
                <span className="claim-modal-label">Context Note</span>
                <p className="claim-modal-note">{activeCellItem.note}</p>
              </div>
            )}

            <div className="claim-modal-actions">
              <button
                type="button"
                className="claim-modal-open-btn"
                onClick={() => {
                  onOpenPassage(activeCellItem)
                  setActiveCellItem(null)
                }}
              >
                <ExternalLink size="var(--icon-detail)" />
                <span>Open passage in source</span>
              </button>
              <button
                type="button"
                className="claim-modal-close-btn"
                onClick={() => setActiveCellItem(null)}
              >
                Done
              </button>
            </div>
          </div>
        </ModalDialog>
      )}
    </div>
  )
}
