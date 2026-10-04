import { useQuery } from '@tanstack/react-query'
import { Link, useSearch } from '@tanstack/react-router'
import { BookOpen, FileText, Link2, StickyNote } from 'lucide-react'
import { api, type Document, type DocumentSummary, type ProjectDetail } from '../../api'

interface DocumentSourcesAndNotesProps {
  document: Document
  enabled?: boolean
}

export function DocumentSourcesAndNotes({ document, enabled = true }: DocumentSourcesAndNotesProps) {
  // SAFETY: In non-strict router context, search params may contain an optional project query parameter.
  const search = useSearch({ strict: false }) as { project?: string }

  const backlinksQuery = useQuery<DocumentSummary[]>({
    queryKey: ['backlinks', document.document_id],
    queryFn: () => api.getBacklinks(document.document_id),
    enabled,
  })

  const projectQuery = useQuery<ProjectDetail | null>({
    queryKey: ['project', search?.project],
    queryFn: () => (search?.project ? api.getProject(search.project) : null),
    enabled: enabled && Boolean(search?.project),
  })

  const backlinks = backlinksQuery.data ?? []
  const project = projectQuery.data
  const projectDocs = project?.documents ?? []
  const projectSources = projectDocs.filter(
    (d) => d.role === 'source' && d.document_id !== document.document_id,
  )
  const projectNotes = projectDocs.filter((d) => d.role === 'note' && d.document_id !== document.document_id)

  return (
    <section className="document-sources-notes" aria-label="Sources and related notes">
      {/* Project Sources */}
      {projectSources.length > 0 && (
        <div className="sources-notes-group">
          <div className="sources-notes-header">
            <h4 className="sources-notes-title">
              <BookOpen size="var(--icon-inline)" aria-hidden="true" />
              <span>Project Sources</span>
            </h4>
            <span className="sources-notes-count" aria-label={`${projectSources.length} project sources`}>
              {projectSources.length}
            </span>
          </div>
          <ul className="sources-notes-list" aria-label="Project sources list">
            {projectSources.map((item) => (
              <li key={item.document_id} className="sources-notes-item">
                <Link
                  to="/documents/$documentId"
                  params={{ documentId: item.document_id }}
                  search={search?.project ? { project: search.project } : {}}
                  className="sources-notes-link"
                >
                  <FileText size="var(--icon-inline)" aria-hidden="true" />
                  <span className="sources-notes-doc-title">{item.document_title || 'Untitled source'}</span>
                </Link>
                {item.notes && <p className="sources-notes-excerpt">{item.notes}</p>}
                {item.excerpt && <p className="sources-notes-excerpt small-muted">{item.excerpt}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Project Notes */}
      {projectNotes.length > 0 && (
        <div className="sources-notes-group">
          <div className="sources-notes-header">
            <h4 className="sources-notes-title">
              <StickyNote size="var(--icon-inline)" aria-hidden="true" />
              <span>Project Notes</span>
            </h4>
            <span className="sources-notes-count" aria-label={`${projectNotes.length} project notes`}>
              {projectNotes.length}
            </span>
          </div>
          <ul className="sources-notes-list" aria-label="Project notes list">
            {projectNotes.map((item) => (
              <li key={item.document_id} className="sources-notes-item">
                <Link
                  to="/documents/$documentId"
                  params={{ documentId: item.document_id }}
                  search={search?.project ? { project: search.project } : {}}
                  className="sources-notes-link"
                >
                  <FileText size="var(--icon-inline)" aria-hidden="true" />
                  <span className="sources-notes-doc-title">{item.document_title || 'Untitled note'}</span>
                </Link>
                {item.notes && <p className="sources-notes-excerpt">{item.notes}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Related Notes via Backlinks */}
      <div className="sources-notes-group">
        <div className="sources-notes-header">
          <h4 className="sources-notes-title">
            <Link2 size="var(--icon-inline)" aria-hidden="true" />
            <span>Related Notes</span>
          </h4>
          <span className="sources-notes-count" aria-label={`${backlinks.length} related notes`}>
            {backlinks.length}
          </span>
        </div>
        <p className="sources-notes-description">
          Other documents in this workspace linking to this document.
        </p>

        {backlinksQuery.isLoading ? (
          <p className="small-muted">Loading related notes…</p>
        ) : backlinks.length === 0 ? (
          <div className="sources-notes-empty">
            <p className="small-muted">No other documents link here yet.</p>
            <p className="small-muted">
              Type <kbd className="backlink-kbd">[[</kbd> in any document to link here.
            </p>
          </div>
        ) : (
          <ul className="sources-notes-list" aria-label="List of linking documents">
            {backlinks.map((link) => (
              <li key={link.document_id} className="sources-notes-item">
                <Link
                  to="/documents/$documentId"
                  params={{ documentId: link.document_id }}
                  className="sources-notes-link"
                >
                  <FileText size="var(--icon-inline)" aria-hidden="true" />
                  <span className="sources-notes-doc-title">{link.title || 'Untitled document'}</span>
                  {link.path && <span className="sources-notes-path">{link.path}</span>}
                </Link>
                {link.search_snippet && (
                  <div className="sources-notes-snippet" title={link.search_snippet}>
                    {link.search_snippet}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
