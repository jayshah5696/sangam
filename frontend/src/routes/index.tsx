import { useDeferredValue, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { FilePlus2, FileText, FileUp, Search } from 'lucide-react'
import { api } from '../api'
import { useWorkbench } from '../workbench'

export const Route = createFileRoute('/')({ component: Welcome })

function Welcome() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const workbench = useWorkbench()
  const [contentType, setContentType] = useState<'text/markdown' | 'text/html'>('text/markdown')
  const [searchQuery, setSearchQuery] = useState('')
  const deferredSearch = useDeferredValue(searchQuery)
  const documents = useQuery({ queryKey: ['documents'], queryFn: api.listDocuments })
  const searchResults = useQuery({
    queryKey: ['documents', 'welcome-search', deferredSearch],
    queryFn: () => api.searchDocuments(deferredSearch),
    enabled: deferredSearch.trim().length > 0,
  })
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
  const isEmpty = Boolean(documents.data && documents.data.length === 0)
  const recentDocuments = documents.data?.slice(0, 3) ?? []
  const trimmedSearch = deferredSearch.trim()
  const matchingDocuments = trimmedSearch ? (searchResults.data ?? []) : (documents.data ?? [])
  return (
    <section className="welcome">
      <p className="eyebrow">Your workspace</p>
      <h1>{isEmpty ? 'Your workspace is empty' : 'Files with memory.'}</h1>
      <p>
        {isEmpty
          ? 'Create a Markdown document or import a PDF to begin.'
          : 'Create Markdown documents, group them into folders, organize them with categories and tags, and find them again through full-text search.'}
      </p>
      <label className="welcome-search">
        <Search size={16} />
        <input
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && matchingDocuments[0]) {
              event.preventDefault()
              setSearchQuery('')
              workbench.ensureDocumentOpen(matchingDocuments[0].document_id, matchingDocuments[0].title)
              void navigate({
                to: '/documents/$documentId',
                params: { documentId: matchingDocuments[0].document_id },
              })
            }
            if (event.key === 'Escape') setSearchQuery('')
          }}
          placeholder={
            isEmpty
              ? 'Nothing to search yet — create a document first'
              : 'Search documents and press Enter to open the top result…'
          }
          aria-label="Quick search documents"
          disabled={isEmpty}
        />
        <span className="welcome-search-hint">
          <kbd>Enter</kbd> open <kbd>Esc</kbd> clear
        </span>
      </label>
      {trimmedSearch && (
        <div className="welcome-search-results" role="list" aria-label="Matching documents">
          {searchResults.isFetching && matchingDocuments.length === 0 && (
            <p className="small-muted">Searching…</p>
          )}
          {!searchResults.isFetching && matchingDocuments.length === 0 && (
            <p className="small-muted">No documents match “{trimmedSearch}”.</p>
          )}
          {matchingDocuments.slice(0, 6).map((document) => (
            <Link
              key={document.document_id}
              to="/documents/$documentId"
              params={{ documentId: document.document_id }}
              role="listitem"
              onClick={() => setSearchQuery('')}
            >
              <FileText size={14} />
              <span>{document.path ?? document.title}</span>
            </Link>
          ))}
        </div>
      )}
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
      </div>
      <div className="welcome-shortcuts">
        <span className="desktop-shortcut">
          <kbd>⌘K</kbd> commands and files
        </span>
        <span className="desktop-shortcut">
          <kbd>/</kbd> focus search
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
