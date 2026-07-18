import { useQuery } from '@tanstack/react-query'
import { api, type Document } from '../api'

export function TrustedHtmlPreview({ document, revisionId }: { document: Document; revisionId: string }) {
  const grant = useQuery({
    queryKey: ['trusted-preview', document.document_id, revisionId, document.trust_version],
    queryFn: () => api.issueTrustedPreview(document, revisionId),
    staleTime: 30_000,
  })
  if (grant.isLoading) return <div className="center-message">Preparing isolated preview…</div>
  if (grant.isError || !grant.data) {
    return <div className="center-message error-text">Trusted preview could not be opened.</div>
  }
  return (
    <iframe
      className="html-preview trusted"
      title="Trusted interactive HTML preview"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={`${grant.data.url}#token=${encodeURIComponent(grant.data.token)}`}
    />
  )
}
