import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { api, type DocumentSummary } from '../api'

export const Route = createFileRoute('/trash')({ component: TrashPage })

function TrashPage() {
  const trash = useQuery({ queryKey: ['trash'], queryFn: api.listDeletedDocuments })
  return (
    <section className="utility-page">
      <header className="utility-header">
        <div>
          <p className="eyebrow">Recoverable deletion</p>
          <h1>Trash</h1>
          <p>Deleted documents keep their stable identity and immutable history until restored.</p>
        </div>
      </header>
      {trash.data?.length === 0 && (
        <div className="empty-state">
          <strong>Trash is empty.</strong>
        </div>
      )}
      <div className="trash-list">
        {trash.data?.map((document) => (
          <DeletedDocument key={document.document_id} document={document} />
        ))}
      </div>
    </section>
  )
}

function DeletedDocument({ document }: { document: DocumentSummary }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const restore = useMutation({
    mutationFn: () => api.restore(document, document.current_revision_id),
    onSuccess: async (restored) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['trash'] }),
        queryClient.invalidateQueries({ queryKey: ['documents'] }),
      ])
      await navigate({ to: '/documents/$documentId', params: { documentId: restored.document_id } })
    },
  })
  return (
    <article className="trash-card">
      <div>
        <h2>{document.title}</h2>
        <code>{document.path ?? 'Unmaterialized draft'}</code>
        <p>
          Deleted {new Date(document.updated_at).toLocaleString()} by {document.updated_by_name}
        </p>
      </div>
      <button disabled={restore.isPending} onClick={() => restore.mutate()}>
        {restore.isPending ? 'Restoring…' : 'Restore document'}
      </button>
    </article>
  )
}
