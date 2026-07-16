import { createFileRoute } from '@tanstack/react-router'
import { WorkbenchView } from '../components/workbench/WorkbenchView'

export const Route = createFileRoute('/documents/$documentId')({ component: DocumentPage })

function DocumentPage() {
  const { documentId } = Route.useParams()
  return <WorkbenchView routeDocumentId={documentId} />
}
