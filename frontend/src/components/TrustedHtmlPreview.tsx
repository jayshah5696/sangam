import { useQuery } from '@tanstack/react-query'
import { api, type Document, type TrustedPreviewGrant } from '../api'
import { StateMessage } from './ui/StateMessage'

export function TrustedHtmlPreview({
  document,
  revisionId,
  grant: suppliedGrant,
  title = 'Interactive HTML preview',
}: {
  document?: Document
  revisionId: string
  grant?: TrustedPreviewGrant
  title?: string
}) {
  const grant = useQuery({
    queryKey: [
      'trusted-preview',
      document?.document_id ?? 'publication',
      revisionId,
      document?.trust_version ?? suppliedGrant?.token,
    ],
    queryFn: () => api.issueTrustedPreview(document!, revisionId),
    enabled: !suppliedGrant && Boolean(document),
    staleTime: 30_000,
  })
  const activeGrant = suppliedGrant ?? grant.data
  if (!suppliedGrant && grant.isLoading) {
    return <StateMessage kind="loading" title="Preparing isolated HTML preview" />
  }
  if (!activeGrant) {
    return (
      <StateMessage
        kind="error"
        title="Interactive HTML preview could not be opened"
        description="Check the workspace JavaScript policy and isolated preview host configuration."
      />
    )
  }
  return (
    <iframe
      className="html-preview trusted"
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={`${activeGrant.url}#token=${encodeURIComponent(activeGrant.token)}`}
    />
  )
}
