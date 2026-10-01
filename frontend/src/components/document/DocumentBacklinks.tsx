import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { FileText, Link2 } from 'lucide-react'

import { api, type Document, type DocumentSummary } from '../../api'

interface DocumentBacklinksProps {
  document: Document
  enabled?: boolean
}

export function DocumentBacklinks({ document, enabled = true }: DocumentBacklinksProps) {
  const backlinksQuery = useQuery<DocumentSummary[]>({
    queryKey: ['backlinks', document.document_id],
    queryFn: () => api.getBacklinks(document.document_id),
    enabled,
  })

  const backlinks = backlinksQuery.data ?? []

  return (
    <section className="document-backlinks" aria-label="Document backlinks">
      <div className="backlinks-header">
        <h4 className="backlinks-title">
          <Link2 size="var(--icon-inline)" aria-hidden="true" />
          <span>Backlinks</span>
        </h4>
        <span className="backlinks-count" aria-label={`${backlinks.length} backlinks`}>
          {backlinks.length}
        </span>
      </div>
      <p className="backlinks-description">Other documents in this workspace linking to this document.</p>

      {backlinksQuery.isLoading ? (
        <p className="small-muted">Loading backlinks…</p>
      ) : backlinks.length === 0 ? (
        <div className="backlinks-empty">
          <p className="small-muted">No other documents link here yet.</p>
          <p className="small-muted">
            Type <kbd className="backlink-kbd">[[</kbd> in any document to link here.
          </p>
        </div>
      ) : (
        <ul className="backlinks-list" aria-label="List of linking documents">
          {backlinks.map((link) => (
            <li key={link.document_id} className="backlink-item">
              <Link
                to="/documents/$documentId"
                params={{ documentId: link.document_id }}
                className="backlink-link"
              >
                <FileText size="var(--icon-inline)" aria-hidden="true" />
                <span className="backlink-title">{link.title || 'Untitled document'}</span>
                {link.path && <span className="backlink-path">{link.path}</span>}
              </Link>
              {link.search_snippet && (
                <div className="backlink-snippet" title={link.search_snippet}>
                  {link.search_snippet}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
