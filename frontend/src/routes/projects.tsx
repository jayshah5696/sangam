import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import {
  api,
  projectRoleSchema,
  type ProjectDetail,
  type ProjectDocumentItem,
  type ProjectRole,
  type ProjectThreadItem,
  type ProjectAnnotationItem,
} from '../api'
import { ProjectDialog } from '../components/projects/ProjectDialog'
import { StateMessage } from '../components/ui/StateMessage'
import { HOME_PROJECT_KEY, useProjectResume } from '../projectResume'
import { useWorkbench } from '../workbench'
import { findGroup, type LayoutNode } from '../workbenchLayout'
import { useDocumentSessions } from '../documentSessions'

export const Route = createFileRoute('/projects')({
  validateSearch: z.object({ project: z.string().optional() }),
  component: ProjectsPage,
})

const roles = projectRoleSchema.options

function ErrorMessage({ error }: { error: Error | null }) {
  return error ? (
    <StateMessage compact kind="error" title="Project change failed" description={error.message} />
  ) : null
}

function ProjectsPage() {
  const { project } = Route.useSearch()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.listProjects })
  const open = (id: string) => {
    localStorage.setItem(HOME_PROJECT_KEY, id)
    void navigate({ to: '/projects', search: { project: id } })
  }
  if (project) return <ProjectView key={project} projectId={project} />
  return (
    <section className="projects-page">
      <header className="projects-header">
        <h1>Projects</h1>
        <button className="primary-button" onClick={() => setCreating(true)}>
          New Project
        </button>
      </header>
      <p>Keep the purpose, sources, drafts and conversations for a body of work together.</p>
      {projects.isPending && <StateMessage kind="loading" title="Loading projects" />}
      {projects.isError && (
        <StateMessage
          kind="error"
          title="Could not load projects"
          description={projects.error.message}
          action={<button onClick={() => void projects.refetch()}>Retry</button>}
        />
      )}
      {projects.data?.length === 0 && (
        <StateMessage
          kind="empty"
          title="No projects yet"
          action={<button onClick={() => setCreating(true)}>Create your first project</button>}
        />
      )}
      <div className="projects-grid">
        {projects.data?.map((p) => (
          <article className="project-section-panel" key={p.project_id}>
            <div className="project-section-body">
              <h2>
                <button className="project-doc-title-btn" onClick={() => open(p.project_id)}>
                  {p.name}
                </button>
              </h2>
              <p>{p.description}</p>
              <p className="small-muted">
                {p.document_count} documents · {p.thread_count} conversations
              </p>
              <button className="secondary-action" onClick={() => open(p.project_id)}>
                Open project
              </button>
            </div>
          </article>
        ))}
      </div>
      {creating && (
        <CreateProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false)
            open(p.project_id)
          }}
        />
      )}
    </section>
  )
}

export function CreateProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (project: ProjectDetail) => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [key] = useState(() => crypto.randomUUID())
  const mutation = useMutation({
    mutationFn: () => api.createProject({ name: name.trim(), description: description.trim() || null }, key),
    onSuccess: async (p) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['documents'] }),
      ])
      onCreated(p)
    },
  })
  return (
    <ProjectDialog title="Create Project" onClose={onClose}>
      <form
        className="project-modal-form"
        onSubmit={(event) => {
          event.preventDefault()
          mutation.mutate()
        }}
      >
        <label className="project-modal-field">
          Project name *
          <input
            autoFocus
            required
            maxLength={120}
            className="project-modal-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="project-modal-field">
          Purpose & Goals
          <textarea
            className="project-modal-textarea"
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <ErrorMessage error={mutation.error} />
        <div className="project-detail-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" disabled={mutation.isPending || !name.trim()}>
            Create Project
          </button>
        </div>
      </form>
    </ProjectDialog>
  )
}

function memberLayout(node: LayoutNode, ids: Set<string>): LayoutNode {
  if (node.kind === 'split')
    return { ...node, first: memberLayout(node.first, ids), second: memberLayout(node.second, ids) }
  const tabs = node.tabs.filter((t) => ids.has(t.documentId))
  return {
    ...node,
    tabs,
    activeTabId: tabs.some((t) => t.documentId === node.activeTabId)
      ? node.activeTabId
      : (tabs[0]?.documentId ?? null),
  }
}

function ProjectView({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const workbench = useWorkbench()
  const sessions = useDocumentSessions()
  const { resume, openDocument, openConversation } = useProjectResume()
  const navigate = useNavigate()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState<string | null>(null)
  const [description, setDescription] = useState('')
  const [threadId, setThreadId] = useState('')
  const [annotationId, setAnnotationId] = useState('')
  const detail = useQuery({ queryKey: ['project', projectId], queryFn: () => api.getProject(projectId) })
  const threads = useQuery({ queryKey: ['project-available-threads'], queryFn: api.listProjectThreads })
  const annotations = useQuery({
    queryKey: ['project-available-annotations', projectId, detail.data?.version],
    queryFn: async () =>
      (
        await Promise.all(
          (detail.data?.documents ?? [])
            .filter((d) => d.content_type === 'application/pdf')
            .map((d) => api.listAnnotations(d.document_id)),
        )
      ).flat(),
    enabled: Boolean(detail.data),
  })
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['projects'] }),
    ])
  }
  const change = useMutation({
    mutationFn: async (updates: Parameters<typeof api.updateProject>[1]) => {
      if (!detail.data) throw new Error('Reload this project before saving')
      return api.updateProject(projectId, { ...updates, expected_version: detail.data.version })
    },
    onSuccess: async () => {
      setName(null)
      await refresh()
    },
  })
  const action = useMutation({
    mutationFn: (
      perform: () => Promise<
        ProjectDetail | ProjectDocumentItem | ProjectThreadItem | ProjectAnnotationItem | void
      >,
    ) => perform(),
    onSuccess: refresh,
  })
  const resumeMutation = useMutation({ mutationFn: () => api.getProject(projectId).then(resume) })
  if (detail.isPending) return <StateMessage kind="loading" title="Loading project" />
  if (detail.isError)
    return (
      <StateMessage
        kind="error"
        title="Could not load project"
        description={detail.error.message}
        action={
          <>
            <button onClick={() => void detail.refetch()}>Retry</button>
            <Link to="/projects" search={{}}>
              Back to projects
            </Link>
          </>
        }
      />
    )
  const project = detail.data
  const snapshot = async () => {
    const root = memberLayout(workbench.root, new Set(project.documents.map((d) => d.document_id)))
    const selectedId = findGroup(root, workbench.activeGroupId)?.activeTabId
    const draft = project.documents.find(
      (d) =>
        d.document_id === selectedId && d.role === 'draft' && d.document_id !== project.brief_document_id,
    )
    for (const doc of project.documents.filter((d) => d.content_type === 'application/pdf')) {
      const page = sessions.getSession(doc.document_id).pdfState?.pageNumber
      if (page && page !== doc.pinned_page)
        await api.updateProjectDocument(projectId, doc.document_id, { pinned_page: page })
    }
    const latest = await api.getProject(projectId)
    const currentThread = localStorage.getItem('sangam.chat-thread.workspace')
    await api.updateProject(projectId, {
      expected_version: latest.version,
      active_document_id: draft?.document_id ?? null,
      active_thread_id: project.threads.some((t) => t.thread_id === currentThread)
        ? currentThread
        : project.active_thread_id,
      workbench_state_json: JSON.stringify({
        schemaVersion: 1,
        root,
        activeGroupId: workbench.activeGroupId,
        recentlyClosed: [],
      }),
    })
  }
  return (
    <section className="projects-page">
      <button className="secondary-action" onClick={() => void navigate({ to: '/projects', search: {} })}>
        Back to projects
      </button>
      <header className="projects-header">
        <div>
          <h1>{project.name}</h1>
          <p>{project.description}</p>
        </div>
        <button className="primary-button" onClick={() => resumeMutation.mutate()}>
          Resume in Workbench
        </button>
      </header>
      <div className="project-detail-actions">
        <button
          onClick={() => {
            setName(project.name)
            setDescription(project.description ?? '')
          }}
        >
          Edit details
        </button>
        <button onClick={() => action.mutate(snapshot)} disabled={action.isPending}>
          Snapshot current layout
        </button>
        <button
          onClick={() => {
            if (confirm('Delete this project? Documents are kept.'))
              action.mutate(async () => {
                await api.deleteProject(projectId)
                await navigate({ to: '/projects', search: {} })
              })
          }}
        >
          Delete project
        </button>
      </div>
      {[change.error, action.error, resumeMutation.error].map((error, i) => (
        <ErrorMessage key={i} error={error} />
      ))}
      {name !== null && (
        <form
          className="project-modal-form"
          onSubmit={(e) => {
            e.preventDefault()
            change.mutate({ name, description: description.trim() || null })
          }}
        >
          <label>
            Project name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="project-modal-input"
            />
          </label>
          <label>
            Purpose
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="project-modal-textarea"
            />
          </label>
          <button disabled={change.isPending}>Save changes</button>
          <button type="button" onClick={() => setName(null)}>
            Cancel
          </button>
          <button type="button" onClick={() => void detail.refetch()}>
            Reload current project
          </button>
        </form>
      )}
      <section className="project-section-panel">
        <header className="project-section-header">
          <h2>Project Brief</h2>
        </header>
        <div className="project-section-body">
          {project.brief_document_id ? (
            <Link to="/documents/$documentId" params={{ documentId: project.brief_document_id }}>
              Open purpose brief
            </Link>
          ) : (
            <StateMessage compact kind="empty" title="No purpose brief" />
          )}
          <label className="project-modal-field">
            Purpose brief
            <select
              className="project-modal-select"
              value={project.brief_document_id ?? ''}
              onChange={(e) =>
                change.mutate({
                  brief_document_id: e.target.value || null,
                  active_document_id:
                    e.target.value === project.active_document_id ? null : project.active_document_id,
                })
              }
            >
              <option value="">No brief</option>
              {project.documents
                .filter((d) => d.content_type === 'text/markdown')
                .map((d) => (
                  <option key={d.document_id} value={d.document_id}>
                    {d.document_title}
                  </option>
                ))}
            </select>
          </label>
          <label className="project-modal-field">
            Active draft
            <select
              className="project-modal-select"
              value={project.active_document_id ?? ''}
              onChange={(e) => change.mutate({ active_document_id: e.target.value || null })}
            >
              <option value="">Choose a draft</option>
              {project.documents
                .filter((d) => d.role === 'draft' && d.document_id !== project.brief_document_id)
                .map((d) => (
                  <option key={d.document_id} value={d.document_id}>
                    {d.document_title}
                  </option>
                ))}
            </select>
          </label>
        </div>
      </section>
      <section className="project-section-panel">
        <header className="project-section-header">
          <h2>Documents & Research Sources</h2>
          <button onClick={() => setAdding(true)}>Add document</button>
        </header>
        <div className="project-section-body project-doc-table">
          {project.documents.length === 0 && (
            <StateMessage compact kind="empty" title="No documents attached" />
          )}
          {project.documents.map((doc) => (
            <DocumentRow
              key={doc.document_id}
              doc={doc}
              active={project.active_document_id === doc.document_id}
              onOpen={() => action.mutate(() => openDocument(doc, undefined, projectId))}
              onUpdate={(updates) =>
                action.mutate(() =>
                  api.updateProjectDocument(projectId, doc.document_id, {
                    ...updates,
                    expected_version: project.version,
                  }),
                )
              }
              onRemove={() => action.mutate(() => api.removeProjectDocument(projectId, doc.document_id))}
            />
          ))}
        </div>
      </section>
      <section className="project-section-panel">
        <header className="project-section-header">
          <h2>Conversations</h2>
        </header>
        <div className="project-section-body">
          {threads.isError && <ErrorMessage error={threads.error} />}
          <label className="project-modal-field">
            Attach conversation
            <select
              className="project-modal-select"
              value={threadId}
              onChange={(e) => setThreadId(e.target.value)}
            >
              <option value="">Choose a conversation</option>
              {threads.data
                ?.filter((t) => !project.threads.some((member) => member.thread_id === t.thread_id))
                .map((t) => (
                  <option key={t.thread_id} value={t.thread_id}>
                    {t.title ?? t.thread_id}
                  </option>
                ))}
            </select>
          </label>
          <button
            disabled={!threadId || action.isPending}
            onClick={() => action.mutate(() => api.addProjectThread(projectId, threadId))}
          >
            Attach conversation
          </button>
          <Link to="/chat">Start a conversation</Link>
          {project.threads.map((t) => (
            <div className="project-doc-row" key={t.thread_id}>
              <button onClick={() => action.mutate(() => openConversation(t.thread_id))}>
                {t.title ?? 'Conversation'}
              </button>
              <button
                onClick={() => change.mutate({ active_thread_id: t.thread_id })}
                aria-pressed={t.thread_id === project.active_thread_id}
              >
                Use on resume
              </button>
              <button onClick={() => action.mutate(() => api.removeProjectThread(projectId, t.thread_id))}>
                Detach
              </button>
            </div>
          ))}
        </div>
      </section>
      <section className="project-section-panel">
        <header className="project-section-header">
          <h2>Collected passages</h2>
        </header>
        <div className="project-section-body">
          {annotations.isError && <ErrorMessage error={annotations.error} />}
          <label className="project-modal-field">
            Attach passage
            <select
              className="project-modal-select"
              value={annotationId}
              onChange={(e) => setAnnotationId(e.target.value)}
            >
              <option value="">Choose an annotation</option>
              {annotations.data
                ?.filter(
                  (a) => !project.annotations.some((member) => member.annotation_id === a.annotation_id),
                )
                .map((a) => (
                  <option key={a.annotation_id} value={a.annotation_id}>
                    Page {a.page_number}: {a.selected_text ?? a.note ?? 'Annotation'}
                  </option>
                ))}
            </select>
          </label>
          <button
            disabled={!annotationId || action.isPending}
            onClick={() => action.mutate(() => api.addProjectAnnotation(projectId, annotationId))}
          >
            Attach passage
          </button>
          {project.annotations.map((a) => (
            <div className="project-doc-row" key={a.annotation_id}>
              <button
                onClick={() => {
                  const doc = project.documents.find((d) => d.document_id === a.document_id)
                  if (doc)
                    action.mutate(() =>
                      openDocument({ ...doc, pinned_page: a.page_number }, a.annotation_id, projectId),
                    )
                }}
              >
                {a.selected_text ?? a.note ?? 'Annotation'} · Page {a.page_number}
              </button>
              <button
                onClick={() => action.mutate(() => api.removeProjectAnnotation(projectId, a.annotation_id))}
              >
                Detach passage
              </button>
            </div>
          ))}
        </div>
      </section>
      {adding && (
        <AddDocumentDialog
          project={project}
          onClose={() => setAdding(false)}
          onAdded={async () => {
            setAdding(false)
            await refresh()
          }}
        />
      )}
    </section>
  )
}

function DocumentRow({
  doc,
  active,
  onOpen,
  onUpdate,
  onRemove,
}: {
  doc: ProjectDocumentItem
  active: boolean
  onOpen: () => void
  onUpdate: (updates: Parameters<typeof api.updateProjectDocument>[2]) => void
  onRemove: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [notes, setNotes] = useState(doc.notes ?? '')
  const [page, setPage] = useState(doc.pinned_page?.toString() ?? '')
  return (
    <article className="project-doc-row">
      <div className="project-doc-main">
        <button className="project-doc-title-btn" onClick={onOpen}>
          {doc.document_title}
        </button>
        <span>
          {doc.role}
          {active ? ' · active draft' : ''}
          {doc.pinned_page ? ` · Page ${doc.pinned_page}` : ''}
        </span>
        <p>{doc.notes}</p>
        {doc.source_updated && (
          <div>
            <span>Source has a newer revision</span>
            <button onClick={() => onUpdate({ source_revision_id: doc.current_revision_id })}>
              Mark source reviewed
            </button>
          </div>
        )}
        {editing && (
          <div className="project-modal-form">
            <label>
              Role
              <select
                value={doc.role}
                onChange={(e) => onUpdate({ role: projectRoleSchema.parse(e.target.value) })}
              >
                {roles.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <label>
              Notes
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
            {doc.content_type === 'application/pdf' && (
              <label>
                Pinned page
                <input type="number" min={1} value={page} onChange={(e) => setPage(e.target.value)} />
              </label>
            )}
            <button
              onClick={() => {
                onUpdate({ notes: notes || null, pinned_page: page ? Number(page) : null })
                setEditing(false)
              }}
            >
              Save reference
            </button>
          </div>
        )}
      </div>
      <div className="project-doc-actions">
        <button onClick={() => setEditing(!editing)}>Edit reference</button>
        <button onClick={onRemove} aria-label={`Remove ${doc.document_title} from project`}>
          Remove
        </button>
      </div>
    </article>
  )
}

function AddDocumentDialog({
  project,
  onClose,
  onAdded,
}: {
  project: ProjectDetail
  onClose: () => void
  onAdded: () => Promise<void>
}) {
  const [documentId, setDocumentId] = useState('')
  const [role, setRole] = useState<ProjectRole>('source')
  const [notes, setNotes] = useState('')
  const [page, setPage] = useState('')
  const docs = useQuery({ queryKey: ['documents', 'all'], queryFn: api.listDocuments })
  const available =
    docs.data?.filter((d) => !project.documents.some((member) => member.document_id === d.document_id)) ?? []
  const mutation = useMutation({
    mutationFn: () =>
      api.addProjectDocument(project.project_id, {
        document_id: documentId,
        role,
        notes: notes || null,
        pinned_page: page ? Number(page) : null,
      }),
    onSuccess: onAdded,
  })
  return (
    <ProjectDialog title="Add Document to Project" onClose={onClose}>
      <form
        className="project-modal-form"
        onSubmit={(e) => {
          e.preventDefault()
          mutation.mutate()
        }}
      >
        <label className="project-modal-field">
          Select document
          <select
            className="project-modal-select"
            required
            value={documentId}
            onChange={(e) => setDocumentId(e.target.value)}
          >
            <option value="">Choose a document</option>
            {available.map((d) => (
              <option key={d.document_id} value={d.document_id}>
                {d.title}
              </option>
            ))}
          </select>
        </label>
        {docs.isPending && <StateMessage compact kind="loading" title="Loading available documents" />}
        {docs.isError && <ErrorMessage error={docs.error} />}
        {docs.isSuccess && available.length === 0 && (
          <StateMessage
            compact
            kind="empty"
            title="No available documents"
            description="Create a document or import a PDF from Home, then attach it here."
          />
        )}
        <label className="project-modal-field">
          Project Role
          <select
            className="project-modal-select"
            value={role}
            onChange={(e) => setRole(projectRoleSchema.parse(e.target.value))}
          >
            {roles.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label className="project-modal-field">
          Notes / Takeaways
          <textarea
            className="project-modal-textarea"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        {available.find((d) => d.document_id === documentId)?.content_type === 'application/pdf' && (
          <label className="project-modal-field">
            Pinned Page
            <input
              className="project-modal-input"
              type="number"
              min={1}
              value={page}
              onChange={(e) => setPage(e.target.value)}
            />
          </label>
        )}
        <ErrorMessage error={mutation.error} />
        <div className="project-detail-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" disabled={mutation.isPending || !documentId}>
            Add to Project
          </button>
        </div>
      </form>
    </ProjectDialog>
  )
}
