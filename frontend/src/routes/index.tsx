import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Command, FilePlus2, FileUp, Search } from 'lucide-react'
import { api } from '../api'
import { useWorkbench } from '../workbench'

export const Route = createFileRoute('/')({ component: Welcome })

function Welcome() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const workbench = useWorkbench()
  const [contentType, setContentType] = useState<'text/markdown' | 'text/html'>('text/markdown')
  const documents = useQuery({ queryKey: ['documents'], queryFn: api.listDocuments })
  const createDocument = useMutation({
    mutationFn: () =>
      api.createDocument(
        contentType === 'text/html' ? 'Untitled HTML document' : 'Untitled document',
        undefined,
        contentType,
      ),
    onSuccess: async (document) => {
      await queryClient.invalidateQueries({ queryKey: ['documents'] })
      workbench.ensureDocumentOpen(document.document_id, document.title)
      await navigate({ to: '/documents/$documentId', params: { documentId: document.document_id } })
    },
  })
  const importPdf = useMutation({
    mutationFn: (file: File) =>
      api.importPdf(
        file,
        file.name.replace(/\.pdf$/i, '') || 'Imported PDF',
        `research/${file.name.toLowerCase().endsWith('.pdf') ? file.name : `${file.name}.pdf`}`,
      ),
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
        <label>
          Format
          <select
            value={contentType}
            onChange={(event) => setContentType(event.target.value as typeof contentType)}
          >
            <option value="text/markdown">Markdown</option>
            <option value="text/html">HTML</option>
          </select>
        </label>
        <button
          className="primary-button"
          disabled={createDocument.isPending}
          onClick={() => createDocument.mutate()}
        >
          <FilePlus2 size={16} />
          {createDocument.isPending
            ? 'Creating…'
            : `Create ${contentType === 'text/html' ? 'HTML' : 'Markdown'}`}
        </button>
        <label className="pdf-import-control">
          <FileUp size={16} />
          <span>{importPdf.isPending ? 'Importing PDF…' : 'Import PDF'}</span>
          <input
            type="file"
            accept="application/pdf,.pdf"
            disabled={importPdf.isPending}
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null
              if (file) importPdf.mutate(file)
            }}
          />
        </label>
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
      {(createDocument.isError || importPdf.isError) && (
        <p className="error-text">The document could not be created or imported.</p>
      )}
    </section>
  )
}
