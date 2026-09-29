import { useDeferredValue, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowRight,
  BookOpen,
  FileCheck2,
  FileCode,
  FilePlus2,
  FileText,
  FileUp,
  MessageSquareText,
  Pin,
  Search,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react'
import { api, DOCUMENT_PAGE_SIZE } from '../api'
import { reviewableProposals } from '../review'
import { collectGroups, useWorkbench } from '../workbench'
import { categorizeProjectDocuments, getProjectResumeAction, selectHomeDocuments } from '../workspaceHome'

export const Route = createFileRoute('/')({ component: Welcome })

function Welcome() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const workbench = useWorkbench()
  const [contentType, setContentType] = useState<'text/markdown' | 'text/html'>('text/markdown')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const deferredSearch = useDeferredValue(searchQuery)

  const documents = useQuery({
    queryKey: ['documents', 'welcome'],
    queryFn: () => api.listDocumentsPage(),
  })
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
  })
  const proposalsQuery = useQuery({
    queryKey: ['chat-proposals', 'workspace-review'],
    queryFn: () => api.listChatProposals(),
  })

  const searchResults = useInfiniteQuery({
    queryKey: ['documents', 'welcome-search', deferredSearch],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.searchDocumentsPage(deferredSearch, undefined, 'relevance', pageParam),
    getNextPageParam: (lastPage, pages) => (lastPage.hasMore ? pages.length * DOCUMENT_PAGE_SIZE : undefined),
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
      await navigate({
        to: '/documents/$documentId',
        params: { documentId: document.document_id },
      })
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
      await navigate({
        to: '/documents/$documentId',
        params: { documentId: document.document_id },
      })
    },
  })

  const projects = projectsQuery.data ?? []
  const activeProject =
    (selectedProjectId ? projects.find((p) => p.project_id === selectedProjectId) : null) ??
    projects[0] ??
    null
  const hasActiveProject = Boolean(activeProject)

  const reviewable = reviewableProposals(proposalsQuery.data ?? [])
  const reviewCount = reviewable.length

  const resumeAction = activeProject ? getProjectResumeAction(activeProject) : null
  const categorizedDocs = activeProject ? categorizeProjectDocuments(activeProject.documents) : null

  const isEmpty = Boolean(
    documents.data && documents.data.items.length === 0 && !documents.data.hasMore && !hasActiveProject,
  )

  const openTabs = collectGroups(workbench.root).flatMap((group) => group.tabs)
  const homeDocuments = selectHomeDocuments(documents.data?.items ?? [], openTabs)
  const recentDocuments = homeDocuments.recent.slice(0, 4)
  const pinnedDocuments = homeDocuments.pinned.slice(0, 4)
  const fallbackDocuments =
    recentDocuments.length === 0 && !hasActiveProject ? (documents.data?.items ?? []).slice(0, 4) : []
  const trimmedSearch = deferredSearch.trim()
  const matchingDocuments = trimmedSearch
    ? (searchResults.data?.pages.flatMap((page) => page.items) ?? [])
    : []

  const heroTitle = activeProject
    ? activeProject.name
    : isEmpty
      ? 'Your workspace is empty'
      : 'Pick up where you left off.'

  const heroSubtitle = activeProject
    ? activeProject.description || 'Active project drafts and context.'
    : isEmpty
      ? 'Create a Markdown document or import a PDF to begin.'
      : 'Open a document or continue editing your workspace.'

  return (
    <section className="welcome">
      <div className="welcome-heading-row">
        <div>
          <p className="eyebrow">{hasActiveProject ? 'Active project' : 'Workspace'}</p>
          <h1>{heroTitle}</h1>
        </div>
        {activeProject && reviewCount > 0 && (
          <Link className="review-home-link" to="/review">
            <ShieldCheck size="var(--icon-inline)" /> Review ({reviewCount})
          </Link>
        )}
      </div>
      <p>{heroSubtitle}</p>

      {activeProject && resumeAction && (
        <section className="welcome-resume-panel" aria-label="Resume next action">
          <div className="welcome-resume-content">
            <div className="welcome-resume-header">
              <span className="welcome-resume-badge">{resumeAction.actionLabel}</span>
              {projects.length > 1 && (
                <div className="welcome-project-picker">
                  <label htmlFor="welcome-project-select">Switch project</label>
                  <select
                    id="welcome-project-select"
                    value={activeProject.project_id}
                    onChange={(event) => setSelectedProjectId(event.target.value)}
                  >
                    {projects.map((project) => (
                      <option key={project.project_id} value={project.project_id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <h2 className="welcome-resume-title">{resumeAction.title}</h2>
            <p className="welcome-resume-hint">{resumeAction.hint}</p>
            {resumeAction.snippet && <p className="welcome-resume-snippet">{resumeAction.snippet}</p>}
          </div>
          {resumeAction.documentId && (
            <Link
              className="primary-button welcome-resume-button"
              to="/documents/$documentId"
              params={{ documentId: resumeAction.documentId }}
              onClick={() => {
                if (resumeAction.documentId) {
                  workbench.ensureDocumentOpen(resumeAction.documentId, resumeAction.title)
                }
              }}
            >
              Resume draft <ArrowRight size="var(--icon-inline)" />
            </Link>
          )}
        </section>
      )}

      {activeProject && reviewCount > 0 && (
        <section className="welcome-review-panel" aria-label="Needs review">
          <div className="welcome-review-info">
            <ShieldAlert size="var(--icon-control)" />
            <div>
              <strong>Needs review</strong>
              <p>
                {reviewCount} pending agent proposal{reviewCount === 1 ? '' : 's'} waiting for approval.
              </p>
            </div>
          </div>
          <Link className="secondary-action" to="/review">
            Open review inbox
          </Link>
        </section>
      )}

      {activeProject && categorizedDocs && (
        <div className="welcome-project-categories" aria-label="Project documents">
          {categorizedDocs.drafts.length > 0 && (
            <div className="welcome-category-group">
              <strong>Drafts</strong>
              <div className="welcome-category-list">
                {categorizedDocs.drafts.map((doc) => (
                  <Link
                    key={doc.document_id}
                    to="/documents/$documentId"
                    params={{ documentId: doc.document_id }}
                    onClick={() => workbench.ensureDocumentOpen(doc.document_id, doc.title)}
                  >
                    <FileText size="var(--icon-inline)" />
                    <span>{doc.title}</span>
                    <small>{doc.path ?? 'Draft'}</small>
                  </Link>
                ))}
              </div>
            </div>
          )}
          {categorizedDocs.sources.length > 0 && (
            <div className="welcome-category-group">
              <strong>Sources</strong>
              <div className="welcome-category-list">
                {categorizedDocs.sources.map((doc) => (
                  <Link
                    key={doc.document_id}
                    to="/documents/$documentId"
                    params={{ documentId: doc.document_id }}
                    onClick={() => workbench.ensureDocumentOpen(doc.document_id, doc.title)}
                  >
                    <BookOpen size="var(--icon-inline)" />
                    <span>{doc.title}</span>
                    <small>{doc.path ?? 'Source'}</small>
                  </Link>
                ))}
              </div>
            </div>
          )}
          {categorizedDocs.notes.length > 0 && (
            <div className="welcome-category-group">
              <strong>Notes</strong>
              <div className="welcome-category-list">
                {categorizedDocs.notes.map((doc) => (
                  <Link
                    key={doc.document_id}
                    to="/documents/$documentId"
                    params={{ documentId: doc.document_id }}
                    onClick={() => workbench.ensureDocumentOpen(doc.document_id, doc.title)}
                  >
                    <FileCode size="var(--icon-inline)" />
                    <span>{doc.title}</span>
                    <small>{doc.path ?? 'Note'}</small>
                  </Link>
                ))}
              </div>
            </div>
          )}
          {categorizedDocs.outputs.length > 0 && (
            <div className="welcome-category-group">
              <strong>Outputs</strong>
              <div className="welcome-category-list">
                {categorizedDocs.outputs.map((doc) => (
                  <Link
                    key={doc.document_id}
                    to="/documents/$documentId"
                    params={{ documentId: doc.document_id }}
                    onClick={() => workbench.ensureDocumentOpen(doc.document_id, doc.title)}
                  >
                    <FileCheck2 size="var(--icon-inline)" />
                    <span>{doc.title}</span>
                    <small>{doc.path ?? 'Output'}</small>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <label className="welcome-search">
        <Search size="var(--icon-control)" />
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
              ? 'Nothing to search yet. Create a document first.'
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
          {matchingDocuments.map((document) => (
            <Link
              key={document.document_id}
              to="/documents/$documentId"
              params={{ documentId: document.document_id }}
              role="listitem"
              onClick={() => setSearchQuery('')}
            >
              <FileText size="var(--icon-inline)" />
              <span>{document.path ?? document.title}</span>
            </Link>
          ))}
          {searchResults.hasNextPage && (
            <button
              className="secondary-action welcome-search-more"
              type="button"
              disabled={searchResults.isFetchingNextPage}
              onClick={() => void searchResults.fetchNextPage()}
            >
              {searchResults.isFetchingNextPage ? 'Loading more…' : 'Load more results'}
            </button>
          )}
        </div>
      )}
      <div className="welcome-actions">
        <label>
          Format
          <select
            value={contentType}
            onChange={(event) => {
              const val = event.target.value
              if (val === 'text/markdown' || val === 'text/html') {
                setContentType(val)
              }
            }}
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
          <FilePlus2 size="var(--icon-control)" />
          {createDocument.isPending
            ? 'Creating…'
            : `Create ${contentType === 'text/html' ? 'HTML' : 'Markdown'}`}
        </button>
        <Link className="secondary-action welcome-chat-action" to="/chat">
          <MessageSquareText size="var(--icon-control)" /> Ask workspace
        </Link>
        <label className="pdf-import-control">
          <FileUp size="var(--icon-control)" />
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
      {(recentDocuments.length > 0 || fallbackDocuments.length > 0) && (
        <div className="welcome-recent">
          <strong>{recentDocuments.length > 0 ? 'Recently open' : 'Recently active'}</strong>
          {[...recentDocuments, ...fallbackDocuments].map((document) => (
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
      {pinnedDocuments.length > 0 && (
        <div className="welcome-recent welcome-pinned">
          <strong>
            <Pin size="var(--icon-inline)" /> Pinned
          </strong>
          {pinnedDocuments.map((document) => (
            <Link
              key={document.document_id}
              to="/documents/$documentId"
              params={{ documentId: document.document_id }}
              onClick={() => workbench.ensureDocumentOpen(document.document_id, document.title)}
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
