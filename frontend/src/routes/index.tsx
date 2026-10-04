import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { Bookmark, ChevronDown, FileCode2, FilePlus2, FileText, Pin } from 'lucide-react'
import { api } from '../api'
import { useDocumentSessions } from '../documentSessions'
import { collectGroups, useWorkbench } from '../workbench'
import { selectHomeDocuments } from '../workspaceHome'
import { StateMessage } from '../components/ui/StateMessage'
import { ActionMenu, ActionMenuItem } from '../components/ActionMenu'
import { ProjectHome } from '../components/projects/ProjectHome'
import { HOME_PROJECT_KEY } from '../projectResume'
import { CaptureDialog } from '../components/capture/CaptureDialog'
import { InboxSection } from '../components/capture/InboxSection'
import { openSearch, useSavedViews } from '../savedViews'

// `?capture=1` lets the command palette open the capture dialog from anywhere.
const homeSearch = z.object({ capture: z.coerce.boolean().optional() })

export const Route = createFileRoute('/')({ component: Welcome, validateSearch: homeSearch })

type HomeSelection = { id: string | null; error: Error | null }

function readHomeSelection(): HomeSelection {
  try {
    return { id: localStorage.getItem(HOME_PROJECT_KEY), error: null }
  } catch (error) {
    return { id: null, error: error instanceof Error ? error : new Error('Could not read Home selection') }
  }
}

function Welcome() {
  const navigate = useNavigate()
  const { capture: captureRequested } = Route.useSearch()
  const [captureOpen, setCaptureOpen] = useState(false)
  const savedViews = useSavedViews()
  const showCapture = captureOpen || Boolean(captureRequested)
  const closeCapture = () => {
    setCaptureOpen(false)
    if (captureRequested) void navigate({ to: '/', search: {}, replace: true })
  }
  const queryClient = useQueryClient()
  const workbench = useWorkbench()
  const sessions = useDocumentSessions()
  const [selection, setSelection] = useState(readHomeSelection)
  const selectedProjectId = selection.id
  const selectionError = selection.error
  const documents = useQuery({ queryKey: ['documents', 'welcome'], queryFn: () => api.listDocumentsPage() })
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: api.listProjects })
  const selected =
    selectedProjectId === ''
      ? undefined
      : (projectsQuery.data?.find((p) => p.project_id === selectedProjectId) ??
        [...(projectsQuery.data ?? [])].sort((a, b) =>
          (b.last_worked_at ?? '').localeCompare(a.last_worked_at ?? ''),
        )[0])
  const selectProject = (id: string) => {
    try {
      localStorage.setItem(HOME_PROJECT_KEY, id)
      setSelection({ id, error: null })
    } catch (error) {
      setSelection((current) => ({
        ...current,
        error: error instanceof Error ? error : new Error('Could not remember the selected project'),
      }))
    }
  }
  const createKeyRef = useRef<string | null>(null)
  const createDocument = useMutation({
    mutationFn: (contentType: 'text/markdown' | 'text/html') => {
      if (!createKeyRef.current) {
        createKeyRef.current = crypto.randomUUID()
      }
      return api.createDocument(
        contentType === 'text/html' ? 'Untitled HTML document' : 'Untitled document',
        undefined,
        contentType,
        undefined,
        createKeyRef.current,
      )
    },
    onSuccess: async (document) => {
      createKeyRef.current = null
      sessions.openForWriting(document)
      if (selected)
        await api.addProjectDocument(selected.project_id, {
          document_id: document.document_id,
          role: 'draft',
        })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['documents'] }),
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['project'] }),
      ])
      workbench.ensureDocumentOpen(document.document_id, document.title)
      await navigate({ to: '/documents/$documentId', params: { documentId: document.document_id } })
    },
  })
  const isEmpty = Boolean(documents.data && documents.data.items.length === 0 && !documents.data.hasMore)
  const openTabs = collectGroups(workbench.root).flatMap((group) => group.tabs)
  const homeDocuments = selectHomeDocuments(documents.data?.items ?? [], openTabs)
  const recentDocuments = homeDocuments.recent.slice(0, 4)
  const pinnedDocuments = homeDocuments.pinned.slice(0, 4)
  const fallbackDocuments = recentDocuments.length === 0 ? (documents.data?.items ?? []).slice(0, 4) : []
  return (
    <section className="welcome welcome-work">
      <div className="welcome-heading-row">
        <div>
          <p className="eyebrow">{selected ? 'Ongoing work' : 'Workspace'}</p>
          <h1>{selected?.name ?? (isEmpty ? 'Your workspace is empty' : 'Your workspace')}</h1>
        </div>
        <ActionMenu
          label="New document"
          className="primary-button welcome-create"
          icon={
            <>
              <FilePlus2 size="var(--icon-control)" />
              {createDocument.isPending ? 'Creating…' : 'New document'}
              <ChevronDown size="var(--icon-inline)" />
            </>
          }
        >
          {(close) => (
            <>
              <ActionMenuItem
                disabled={createDocument.isPending}
                onSelect={() => {
                  createDocument.mutate('text/markdown')
                  close()
                }}
              >
                <FileText size="var(--icon-inline)" /> Markdown
              </ActionMenuItem>
              <ActionMenuItem
                disabled={createDocument.isPending}
                onSelect={() => {
                  createDocument.mutate('text/html')
                  close()
                }}
              >
                <FileCode2 size="var(--icon-inline)" /> HTML
              </ActionMenuItem>
            </>
          )}
        </ActionMenu>
      </div>
      {selected?.description && <p className="welcome-description">{selected.description}</p>}
      {isEmpty && (
        <StateMessage compact kind="empty" title="Create a document or capture material to begin." />
      )}
      {createDocument.isError && (
        <StateMessage
          compact
          kind="error"
          title="The document could not be created or attached"
          description={createDocument.error.message}
        />
      )}
      {projectsQuery.isError && (
        <StateMessage
          compact
          kind="error"
          title="Could not load projects"
          description={projectsQuery.error.message}
          action={<button onClick={() => void projectsQuery.refetch()}>Retry</button>}
        />
      )}
      {selectionError && (
        <StateMessage
          compact
          kind="error"
          title="Could not save Home selection"
          description={selectionError.message}
        />
      )}
      <ProjectHome
        projects={projectsQuery.data ?? []}
        selectedId={selected?.project_id ?? ''}
        onSelect={selectProject}
      />
      {documents.isError && (
        <StateMessage
          compact
          kind="error"
          title="Could not load workspace documents"
          description={documents.error.message}
          action={<button onClick={() => void documents.refetch()}>Retry</button>}
        />
      )}
      {documents.isPending && <StateMessage compact kind="loading" title="Loading recent documents" />}
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
      <InboxSection onCapture={() => setCaptureOpen(true)} />
      {savedViews.length > 0 && (
        <div className="welcome-recent welcome-saved-views">
          <strong>
            <Bookmark size="var(--icon-inline)" /> Saved views
          </strong>
          {savedViews.slice(0, 6).map((view) => (
            <button key={view.view_id} type="button" onClick={() => openSearch(view.filters)}>
              <span>{view.name}</span>
            </button>
          ))}
        </div>
      )}
      {showCapture && (
        <CaptureDialog
          projects={projectsQuery.data ?? []}
          defaultProjectId={selected?.project_id}
          onClose={closeCapture}
        />
      )}
    </section>
  )
}
