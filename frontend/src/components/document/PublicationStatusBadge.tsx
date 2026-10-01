import { useQuery } from '@tanstack/react-query'
import { Globe2 } from 'lucide-react'
import { api, type Document } from '../../api'
import { useDocumentSessions } from '../../documentSessions'
import { publicationStatus } from '../../publicationStatus'
import { useTheme } from '../../theme'

/**
 * Shows near the title whether readers see this draft. When the saved draft has
 * moved past the published revision, the badge opens that exact comparison.
 */
export function PublicationStatusBadge({ document }: { document: Document }) {
  const sessions = useDocumentSessions()
  const { updatePreferences } = useTheme()
  const publication = useQuery({
    queryKey: ['publication', document.document_id],
    queryFn: () => api.getDocumentPublication(document.document_id),
    enabled: document.content_type !== 'application/pdf',
  })
  const status = publicationStatus(publication.data, document.current_revision_id)
  if (status.kind === 'private') return null
  const openInspector = (tab: 'properties' | 'history') =>
    updatePreferences({ rightVisible: true, rightTab: tab })
  if (status.kind === 'current') {
    return (
      <button
        type="button"
        className="publication-status current"
        title="Readers see this saved revision"
        onClick={() => openInspector('properties')}
      >
        <Globe2 size="var(--icon-detail)" aria-hidden="true" /> Published
      </button>
    )
  }
  return (
    <button
      type="button"
      className="publication-status behind"
      title="Compare the published revision with the saved draft"
      onClick={() => {
        sessions.updateSession(document.document_id, {
          compareFrom: status.publishedRevisionId,
          compareTo: status.draftRevisionId,
        })
        openInspector('history')
      }}
    >
      <Globe2 size="var(--icon-detail)" aria-hidden="true" /> Published version differs
    </button>
  )
}
