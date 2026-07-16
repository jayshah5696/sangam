import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Command, FilePlus2, Search } from 'lucide-react'
import { api } from '../api'
import { useWorkbench } from '../workbench'

export const Route = createFileRoute('/')({ component: Welcome })

function Welcome() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const workbench = useWorkbench()
  const documents = useQuery({ queryKey: ['documents', 'welcome'], queryFn: api.listDocuments })
  const createDocument = useMutation({
    mutationFn: () => api.createDocument('Untitled document'),
    onSuccess: async (document) => {
      await queryClient.invalidateQueries({ queryKey: ['documents'] })
      workbench.ensureDocumentOpen(document.document_id, document.title)
      await navigate({ to: '/documents/$documentId', params: { documentId: document.document_id } })
    },
  })
  const recentDocuments = documents.data?.slice(0, 3) ?? []
  return (
    <section className="welcome">
      <p className="eyebrow">Your workspace</p>
      <h1>Files with memory.</h1>
      <p>
        Create Markdown documents, group them into folders, organize them with categories and tags, and find
        them again through full-text search.
      </p>
      <div className="welcome-actions">
        <button
          className="primary-button"
          disabled={createDocument.isPending}
          onClick={() => createDocument.mutate()}
        >
          <FilePlus2 size={16} />
          {createDocument.isPending ? 'Creating…' : 'Create a document'}
        </button>
        <span>
          <Command size={14} /> <kbd>⌘ K</kbd> commands
        </span>
        <span>
          <Search size={14} /> Search from the sidebar
        </span>
      </div>
      {recentDocuments.length > 0 && (
        <div className="welcome-recent">
          <strong>Continue writing</strong>
          {recentDocuments.map((document) => (
            <Link
              key={document.document_id}
              to="/documents/$documentId"
              params={{ documentId: document.document_id }}
            >
              <span>{document.title}</span>
              <small>{document.path ?? 'Draft'}</small>
            </Link>
          ))}
        </div>
      )}
      {createDocument.isError && <p className="error-text">The document could not be created.</p>}
    </section>
  )
}
