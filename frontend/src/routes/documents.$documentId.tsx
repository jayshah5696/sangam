import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { api } from '../api'
import { useDocumentSessions } from '../documentSessions'
import { StateMessage } from '../components/ui/StateMessage'
import { WorkbenchView } from '../components/workbench/WorkbenchView'

const documentSearch = z.object({
  project: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  annotation: z.string().optional(),
})

export const Route = createFileRoute('/documents/$documentId')({
  validateSearch: documentSearch,
  component: DocumentPage,
})

function DocumentPage() {
  const { documentId } = Route.useParams()
  const search = Route.useSearch()
  return (
    <DocumentContext
      key={`${documentId}:${search.project}:${search.page}:${search.annotation}`}
      documentId={documentId}
      search={search}
    />
  )
}

function DocumentContext({
  documentId,
  search,
}: {
  documentId: string
  search: z.infer<typeof documentSearch>
}) {
  const sessions = useDocumentSessions()
  const needsContext = Boolean(search.project || search.page || search.annotation)
  const context = useQuery({
    queryKey: ['project-document-context', documentId, search.project, search.page, search.annotation],
    enabled: needsContext,
    gcTime: 0,
    staleTime: Infinity,
    queryFn: async () => {
      const project = search.project ? await api.getProject(search.project) : null
      for (const doc of project?.documents ?? []) {
        if (doc.content_type === 'application/pdf')
          sessions.updateSession(doc.document_id, {
            pdfState: { pageNumber: doc.pinned_page ?? 1, scale: 1, zoomMode: 'fit-width', scrollTop: 0 },
          })
      }
      if (search.page)
        sessions.updateSession(documentId, {
          pdfState: { pageNumber: search.page, scale: 1, zoomMode: 'fit-width', scrollTop: 0 },
          pdfSelectedAnnotationId: search.annotation ?? null,
        })
      return true
    },
  })
  if (context.isError)
    return (
      <StateMessage
        kind="error"
        title="Could not restore project context"
        description={context.error.message}
        action={<button onClick={() => void context.refetch()}>Retry</button>}
      />
    )
  if (needsContext && !context.isSuccess)
    return <StateMessage kind="loading" title="Restoring project context" />
  return <WorkbenchView routeDocumentId={documentId} />
}
