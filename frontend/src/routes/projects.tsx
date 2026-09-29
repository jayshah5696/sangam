import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  FolderKanban,
  Layout,
  MessageSquare,
  Plus,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { api, type ProjectDetail, type ProjectRole, projectRoleSchema, type ProjectSummary } from '../api'
import { StateMessage } from '../components/ui/StateMessage'
import { useWorkbench } from '../workbench'
import { parseWorkbenchLayoutState } from '../workbenchLayout'

export const Route = createFileRoute('/projects')({
  component: ProjectsPage,
})

const roleColors = {
  source: 'var(--accent)',
  draft: '#3b82f6',
  note: '#eab308',
  output: '#10b981',
  decision: '#8b5cf6',
} satisfies Record<ProjectRole, string>

const ROLE_OPTIONS = [
  {
    value: 'source',
    label: 'Source',
    description: 'Reference or research source material',
  },
  {
    value: 'draft',
    label: 'Draft',
    description: 'Working draft document being authored',
  },
  {
    value: 'note',
    label: 'Note',
    description: 'Exploratory notes or meeting summaries',
  },
  {
    value: 'output',
    label: 'Output',
    description: 'Deliverable, report, or finalized artifact',
  },
  {
    value: 'decision',
    label: 'Decision',
    description: 'Architectural or project decision record',
  },
] satisfies { value: ProjectRole; label: string; description: string }[]

function ProjectsPage() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const queryClient = useQueryClient()

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
  })

  const filteredProjects = useMemo(() => {
    const list = projectsQuery.data ?? []
    if (!searchQuery.trim()) return list
    const q = searchQuery.toLowerCase()
    return list.filter(
      (p) => p.name.toLowerCase().includes(q) || (p.description && p.description.toLowerCase().includes(q)),
    )
  }, [projectsQuery.data, searchQuery])

  if (selectedProjectId) {
    return <ProjectDetailView projectId={selectedProjectId} onBack={() => setSelectedProjectId(null)} />
  }

  return (
    <section className="utility-page">
      <header
        className="utility-header"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 'var(--space-3)',
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>Projects</h1>
          <p
            style={{
              margin: 'var(--space-1) 0 0',
              color: 'var(--muted)',
              fontSize: 'var(--text-body)',
            }}
          >
            Persistent homes for research, investigations, and writing efforts.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button className="primary-button" type="button" onClick={() => setShowCreateModal(true)}>
            <Plus size="var(--icon-control)" /> New Project
          </button>
        </div>
      </header>

      <div style={{ margin: 'var(--space-3) 0' }}>
        <div
          style={{
            position: 'relative',
            maxWidth: '24rem',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <Search
            size="var(--icon-detail)"
            style={{
              position: 'absolute',
              left: 'var(--space-3)',
              color: 'var(--muted)',
              pointerEvents: 'none',
            }}
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter projects…"
            aria-label="Filter projects"
            style={{
              width: '100%',
              paddingLeft: 'var(--space-6)',
              paddingRight: 'var(--space-3)',
              height: 'var(--control-height)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-control)',
              background: 'var(--surface-soft)',
              color: 'var(--text)',
            }}
          />
        </div>
      </div>

      {projectsQuery.isLoading && <StateMessage kind="loading" title="Loading projects…" />}

      {projectsQuery.isError && (
        <StateMessage
          kind="error"
          title="Could not load projects"
          action={
            <button className="secondary-action" onClick={() => void projectsQuery.refetch()}>
              Retry
            </button>
          }
        />
      )}

      {projectsQuery.data && projectsQuery.data.length === 0 && (
        <StateMessage
          kind="empty"
          title="No projects yet"
          description="Create a project to give your research, writing, or investigations a dedicated home with shared sources and persistent layout."
          action={
            <button className="primary-button" type="button" onClick={() => setShowCreateModal(true)}>
              <Plus size="var(--icon-control)" /> Create your first project
            </button>
          }
        />
      )}

      {projectsQuery.data && projectsQuery.data.length > 0 && filteredProjects.length === 0 && (
        <StateMessage
          kind="empty"
          title="No matching projects"
          description={`No projects match "${searchQuery}".`}
        />
      )}

      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        {filteredProjects.map((project) => (
          <ProjectCard
            key={project.project_id}
            project={project}
            onOpen={() => setSelectedProjectId(project.project_id)}
          />
        ))}
      </div>

      {showCreateModal && (
        <CreateProjectModal
          onClose={() => setShowCreateModal(false)}
          onCreated={(created) => {
            setShowCreateModal(false)
            void queryClient.invalidateQueries({ queryKey: ['projects'] })
            setSelectedProjectId(created.project_id)
          }}
        />
      )}
    </section>
  )
}

function ProjectCard({ project, onOpen }: { project: ProjectSummary; onOpen: () => void }) {
  const navigate = useNavigate()
  const workbench = useWorkbench()
  const queryClient = useQueryClient()

  const resumeProject = async () => {
    const detail = await api.getProject(project.project_id)
    if (detail.workbench_state_json) {
      try {
        const layout = parseWorkbenchLayoutState(JSON.parse(detail.workbench_state_json))
        if (layout) {
          workbench.restoreLayout(layout)
        }
      } catch {
        // fallback to opening documents
      }
    }

    const targetDocId = detail.brief_document_id ?? detail.documents[0]?.document_id
    if (targetDocId) {
      workbench.ensureDocumentOpen(
        targetDocId,
        detail.brief_document_title ?? detail.documents[0]?.document_title ?? 'Document',
      )
      void navigate({
        to: '/documents/$documentId',
        params: { documentId: targetDocId },
      })
    } else {
      onOpen()
    }
  }

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteProject(project.project_id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  return (
    <article className="publication-card">
      <div className="publication-card-main">
        <div>
          <button
            type="button"
            onClick={onOpen}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              color: 'var(--text)',
              fontSize: 'var(--text-title-sm)',
              fontWeight: 600,
            }}
          >
            <FolderKanban size="var(--icon-inline)" /> {project.name}
          </button>
        </div>

        {project.description && (
          <p
            style={{
              margin: 0,
              color: 'var(--muted)',
              fontSize: 'var(--text-body)',
            }}
          >
            {project.description}
          </p>
        )}

        <div className="publication-badges">
          {project.brief_document_id && (
            <span
              className="scope-badge"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-1)',
                background: 'var(--surface-soft)',
              }}
            >
              <BookOpen size="var(--icon-detail)" />
              {project.brief_document_title ?? 'Brief'}
            </span>
          )}
          <span className="scope-badge">
            {project.document_count} {project.document_count === 1 ? 'document' : 'documents'}
          </span>
          {project.thread_count > 0 && (
            <span className="scope-badge">
              {project.thread_count} {project.thread_count === 1 ? 'thread' : 'threads'}
            </span>
          )}
          {project.annotation_count > 0 && (
            <span className="scope-badge">
              {project.annotation_count} {project.annotation_count === 1 ? 'annotation' : 'annotations'}
            </span>
          )}
          <span className="scope-badge" style={{ color: 'var(--muted)' }}>
            Updated {new Date(project.updated_at).toLocaleDateString()}
          </span>
        </div>
      </div>

      <div className="publication-card-actions">
        <button
          className="primary-button"
          type="button"
          onClick={() => void resumeProject()}
          title="Resume workbench layout and open documents"
        >
          <Layout size="var(--icon-control)" /> Resume
        </button>
        <button className="secondary-action" type="button" onClick={onOpen}>
          Manage <ChevronRight size="var(--icon-control)" />
        </button>
        <button
          className="secondary-action"
          type="button"
          aria-label={`Delete ${project.name}`}
          onClick={() => {
            if (window.confirm(`Delete project "${project.name}"? Source documents will not be deleted.`)) {
              deleteMutation.mutate()
            }
          }}
          disabled={deleteMutation.isPending}
        >
          <Trash2 size="var(--icon-control)" />
        </button>
      </div>
    </article>
  )
}

function ProjectDetailView({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const navigate = useNavigate()
  const workbench = useWorkbench()

  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [showAddDocModal, setShowAddDocModal] = useState(false)

  const detailQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
  })

  const updateMutation = useMutation({
    mutationFn: (updates: {
      name?: string
      description?: string | null
      brief_document_id?: string | null
      workbench_state_json?: string | null
    }) => api.updateProject(projectId, updates),
    onSuccess: async () => {
      setIsEditing(false)
      await detailQuery.refetch()
    },
  })

  const removeDocMutation = useMutation({
    mutationFn: (docId: string) => api.removeProjectDocument(projectId, docId),
    onSuccess: async () => {
      await detailQuery.refetch()
    },
  })

  if (detailQuery.isLoading) {
    return (
      <section className="utility-page">
        <StateMessage kind="loading" title="Loading project details…" />
      </section>
    )
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <section className="utility-page">
        <StateMessage
          kind="error"
          title="Could not load project"
          action={
            <button className="secondary-action" onClick={onBack}>
              Back to projects
            </button>
          }
        />
      </section>
    )
  }

  const project: ProjectDetail = detailQuery.data

  const handleResumeWorkbench = () => {
    if (project.workbench_state_json) {
      try {
        const layout = parseWorkbenchLayoutState(JSON.parse(project.workbench_state_json))
        if (layout) {
          workbench.restoreLayout(layout)
        }
      } catch {
        // fallback
      }
    }

    const targetDocId = project.brief_document_id ?? project.documents[0]?.document_id
    if (targetDocId) {
      const doc = project.documents.find((d) => d.document_id === targetDocId)
      workbench.ensureDocumentOpen(
        targetDocId,
        project.brief_document_title ?? doc?.document_title ?? 'Document',
      )
      void navigate({
        to: '/documents/$documentId',
        params: { documentId: targetDocId },
      })
    }
  }

  const handleSaveCurrentLayout = () => {
    const currentLayoutJson = JSON.stringify({
      schemaVersion: 1,
      root: workbench.root,
      activeGroupId: workbench.activeGroupId,
      recentlyClosed: workbench.recentlyClosed,
    })
    updateMutation.mutate({ workbench_state_json: currentLayoutJson })
  }

  return (
    <section className="utility-page">
      <div style={{ marginBottom: 'var(--space-3)' }}>
        <button
          className="secondary-action"
          type="button"
          onClick={onBack}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
          }}
        >
          <ArrowLeft size="var(--icon-inline)" /> Back to projects
        </button>
      </div>

      <header
        className="utility-header"
        style={{
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: 'var(--space-3)',
        }}
      >
        <div style={{ flex: 1, minWidth: '18rem' }}>
          {isEditing ? (
            <div
              style={{
                display: 'grid',
                gap: 'var(--space-2)',
                marginBottom: 'var(--space-2)',
              }}
            >
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                style={{
                  height: 'var(--control-height)',
                  padding: '0 var(--space-3)',
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--radius-control)',
                  background: 'var(--surface-soft)',
                  color: 'var(--text)',
                  fontSize: 'var(--text-title-sm)',
                  fontWeight: 600,
                }}
              />
              <textarea
                rows={2}
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                style={{
                  padding: 'var(--space-2) var(--space-3)',
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--radius-control)',
                  background: 'var(--surface-soft)',
                  color: 'var(--text)',
                  fontSize: 'var(--text-body)',
                }}
              />
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() =>
                    updateMutation.mutate({
                      name: editName.trim() || project.name,
                      description: editDescription.trim() || null,
                    })
                  }
                  disabled={updateMutation.isPending}
                >
                  <Save size="var(--icon-control)" /> Save changes
                </button>
                <button className="secondary-action" type="button" onClick={() => setIsEditing(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                }}
              >
                <h1 style={{ margin: 0 }}>{project.name}</h1>
                <button
                  className="secondary-action"
                  type="button"
                  onClick={() => {
                    setEditName(project.name)
                    setEditDescription(project.description ?? '')
                    setIsEditing(true)
                  }}
                  style={{ fontSize: 'var(--text-meta)' }}
                >
                  Edit details
                </button>
              </div>
              {project.description && (
                <p
                  style={{
                    marginTop: 'var(--space-1)',
                    fontSize: 'var(--text-body)',
                  }}
                >
                  {project.description}
                </p>
              )}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
          <button
            className="primary-button"
            type="button"
            onClick={handleResumeWorkbench}
            title="Restore saved workbench splits, tabs, and documents"
          >
            <Layout size="var(--icon-control)" /> Resume in Workbench
          </button>
          <button
            className="secondary-action"
            type="button"
            onClick={handleSaveCurrentLayout}
            title="Snapshot current open workbench tabs and layout into this project"
            disabled={updateMutation.isPending}
          >
            <Save size="var(--icon-control)" /> Snapshot current layout
          </button>
        </div>
      </header>

      {/* Brief Card */}
      <section
        style={{
          marginTop: 'var(--space-4)',
          padding: 'var(--space-4)',
          borderRadius: 'var(--radius-panel)',
          border: '1px solid var(--line)',
          background: 'var(--surface)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 'var(--space-2)',
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 'var(--text-body)',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
            }}
          >
            <BookOpen size="var(--icon-inline)" /> Project Brief
          </h2>
          {project.brief_document_id && (
            <Link
              to="/documents/$documentId"
              params={{ documentId: project.brief_document_id }}
              className="secondary-action"
              style={{ fontSize: 'var(--text-meta)' }}
            >
              Open brief in editor
            </Link>
          )}
        </div>

        {project.brief_document_id ? (
          <div>
            <p
              style={{
                fontWeight: 600,
                margin: 0,
                fontSize: 'var(--text-title-sm)',
              }}
            >
              {project.brief_document_title ?? 'Project Brief'}
            </p>
            <p
              style={{
                color: 'var(--muted)',
                margin: 'var(--space-1) 0 0',
                fontSize: 'var(--text-meta)',
              }}
            >
              Ordinary Markdown brief holding scope, background, open questions, and deliverables.
            </p>
          </div>
        ) : (
          <p
            style={{
              color: 'var(--muted)',
              margin: 0,
              fontSize: 'var(--text-meta)',
            }}
          >
            No brief linked yet. You can set any document as the project brief.
          </p>
        )}
      </section>

      {/* Documents & Sources Section */}
      <section style={{ marginTop: 'var(--space-5)' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 'var(--space-3)',
          }}
        >
          <div>
            <h2
              style={{
                margin: 0,
                fontSize: 'var(--text-title-sm)',
                fontWeight: 600,
              }}
            >
              Documents & Research Sources
            </h2>
            <p
              style={{
                margin: 'var(--space-1) 0 0',
                color: 'var(--muted)',
                fontSize: 'var(--text-meta)',
              }}
            >
              Documents belong to this project by reference. One document can support multiple projects.
            </p>
          </div>

          <button className="secondary-action" type="button" onClick={() => setShowAddDocModal(true)}>
            <Plus size="var(--icon-control)" /> Add document
          </button>
        </div>

        {project.documents.length === 0 ? (
          <StateMessage
            kind="empty"
            title="No documents attached"
            description="Add existing documents or PDFs to this project to organize your sources, drafts, notes, and outputs."
            action={
              <button className="primary-button" type="button" onClick={() => setShowAddDocModal(true)}>
                <Plus size="var(--icon-control)" /> Add first document
              </button>
            }
          />
        ) : (
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            {project.documents.map((doc) => (
              <article
                key={doc.document_id}
                className="publication-card"
                style={{ padding: 'var(--space-3)' }}
              >
                <div className="publication-card-main">
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-2)',
                      flexWrap: 'wrap',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        workbench.ensureDocumentOpen(doc.document_id, doc.document_title)
                        void navigate({
                          to: '/documents/$documentId',
                          params: { documentId: doc.document_id },
                        })
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        color: 'var(--text)',
                        fontWeight: 600,
                        fontSize: 'var(--text-body)',
                        textAlign: 'left',
                      }}
                    >
                      {doc.document_title}
                    </button>
                    <code
                      style={{
                        fontSize: 'var(--text-meta)',
                        color: 'var(--muted)',
                      }}
                    >
                      {doc.document_path}
                    </code>
                  </div>

                  {doc.notes && (
                    <p
                      style={{
                        margin: 'var(--space-1) 0 0',
                        color: 'var(--muted)',
                        fontSize: 'var(--text-meta)',
                      }}
                    >
                      {doc.notes}
                    </p>
                  )}

                  <div className="publication-badges">
                    <span
                      className="scope-badge"
                      style={{
                        borderColor: roleColors[doc.role],
                        color: roleColors[doc.role],
                        fontWeight: 500,
                      }}
                    >
                      {doc.role}
                    </span>
                    {doc.pinned_page && <span className="scope-badge">Page {doc.pinned_page}</span>}
                  </div>
                </div>

                <div className="publication-card-actions">
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={() => {
                      workbench.ensureDocumentOpen(doc.document_id, doc.document_title)
                      void navigate({
                        to: '/documents/$documentId',
                        params: { documentId: doc.document_id },
                      })
                    }}
                  >
                    Open
                  </button>
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={() => removeDocMutation.mutate(doc.document_id)}
                    disabled={removeDocMutation.isPending}
                    aria-label={`Remove ${doc.document_title} from project`}
                  >
                    <Trash2 size="var(--icon-control)" />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* Relevant Chat Threads */}
      <section style={{ marginTop: 'var(--space-5)' }}>
        <h2
          style={{
            margin: 0,
            fontSize: 'var(--text-title-sm)',
            fontWeight: 600,
          }}
        >
          Relevant Chat Threads
        </h2>
        <p
          style={{
            margin: 'var(--space-1) 0 var(--space-3)',
            color: 'var(--muted)',
            fontSize: 'var(--text-meta)',
          }}
        >
          Discussions and AI investigations linked to this body of work.
        </p>

        {project.threads.length === 0 ? (
          <p
            style={{
              color: 'var(--muted)',
              fontSize: 'var(--text-meta)',
              fontStyle: 'italic',
            }}
          >
            No chat threads linked yet. Link threads from Workspace Chat to keep your conversations attached.
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            {project.threads.map((t) => (
              <div key={t.thread_id} className="publication-card" style={{ padding: 'var(--space-3)' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                  }}
                >
                  <MessageSquare size="var(--icon-inline)" />
                  <span style={{ fontWeight: 500 }}>{t.title ?? 'Conversation'}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {showAddDocModal && (
        <AddDocumentModal
          projectId={project.project_id}
          existingDocIds={new Set(project.documents.map((d) => d.document_id))}
          onClose={() => setShowAddDocModal(false)}
          onAdded={async () => {
            setShowAddDocModal(false)
            await detailQuery.refetch()
          }}
        />
      )}
    </section>
  )
}

function CreateProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (project: ProjectDetail) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const workbench = useWorkbench()

  const createMutation = useMutation({
    mutationFn: async () => {
      const proj = await api.createProject({
        name: name.trim(),
        description: description.trim() || null,
      })

      // Try capturing current workbench layout
      const currentLayoutJson = JSON.stringify({
        schemaVersion: 1,
        root: workbench.root,
        activeGroupId: workbench.activeGroupId,
        recentlyClosed: workbench.recentlyClosed,
      })
      if (currentLayoutJson) {
        try {
          return await api.updateProject(proj.project_id, {
            workbench_state_json: currentLayoutJson,
          })
        } catch {
          // ignore layout update error
        }
      }
      return proj
    },
    onSuccess: (proj) => {
      onCreated(proj)
    },
  })

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-4)',
        overflowY: 'auto',
        zIndex: 50,
      }}
    >
      <div
        className="publication-edit-dialog"
        style={{
          width: 'min(36rem, calc(100vw - var(--space-5) * 2))',
          maxHeight: 'calc(100dvh - var(--space-5) * 2)',
          overflowY: 'auto',
          padding: 'var(--space-4)',
          background: 'var(--surface)',
          borderRadius: 'var(--radius-panel)',
          border: '1px solid var(--line)',
        }}
      >
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 'var(--space-3)',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 'var(--text-title-sm)' }}>Create Project</h2>
          <button type="button" className="secondary-action" onClick={onClose} aria-label="Close">
            <X size="var(--icon-control)" />
          </button>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            createMutation.mutate()
          }}
          style={{ display: 'grid', gap: 'var(--space-3)' }}
        >
          <label style={{ display: 'grid', gap: 'var(--space-1)' }}>
            <span style={{ fontSize: 'var(--text-label)', color: 'var(--muted)' }}>Project name *</span>
            <input
              type="text"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Distributed Consensus Investigation"
              style={{
                height: 'var(--control-height)',
                padding: '0 var(--space-3)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-control)',
                background: 'var(--surface-soft)',
                color: 'var(--text)',
              }}
            />
          </label>

          <label style={{ display: 'grid', gap: 'var(--space-1)' }}>
            <span style={{ fontSize: 'var(--text-label)', color: 'var(--muted)' }}>
              Purpose & Goals (optional)
            </span>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What questions is this project answering? What are the deliverables?"
              style={{
                padding: 'var(--space-2) var(--space-3)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-control)',
                background: 'var(--surface-soft)',
                color: 'var(--text)',
                fontSize: 'var(--text-body)',
              }}
            />
          </label>

          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 'var(--space-2)',
              marginTop: 'var(--space-2)',
            }}
          >
            <button className="secondary-action" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={createMutation.isPending || !name.trim()}
            >
              Create Project
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function AddDocumentModal({
  projectId,
  existingDocIds,
  onClose,
  onAdded,
}: {
  projectId: string
  existingDocIds: Set<string>
  onClose: () => void
  onAdded: () => Promise<void>
}) {
  const [selectedDocId, setSelectedDocId] = useState('')
  const [role, setRole] = useState<ProjectRole>('source')
  const [pinnedPage, setPinnedPage] = useState('')
  const [notes, setNotes] = useState('')

  const docsQuery = useQuery({
    queryKey: ['documents', 'all'],
    queryFn: () => api.listDocuments(),
  })

  const availableDocs = useMemo(() => {
    return (docsQuery.data ?? []).filter((d) => !existingDocIds.has(d.document_id))
  }, [docsQuery.data, existingDocIds])

  const addMutation = useMutation({
    mutationFn: () =>
      api.addProjectDocument(projectId, {
        document_id: selectedDocId,
        role,
        pinned_page: pinnedPage.trim() ? Number.parseInt(pinnedPage, 10) : null,
        notes: notes.trim() || null,
      }),
    onSuccess: async () => {
      await onAdded()
    },
  })

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-4)',
        overflowY: 'auto',
        zIndex: 50,
      }}
    >
      <div
        className="publication-edit-dialog"
        style={{
          width: 'min(36rem, calc(100vw - var(--space-5) * 2))',
          maxHeight: 'calc(100dvh - var(--space-5) * 2)',
          overflowY: 'auto',
          padding: 'var(--space-4)',
          background: 'var(--surface)',
          borderRadius: 'var(--radius-panel)',
          border: '1px solid var(--line)',
        }}
      >
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 'var(--space-3)',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 'var(--text-title-sm)' }}>Add Document to Project</h2>
          <button type="button" className="secondary-action" onClick={onClose} aria-label="Close">
            <X size="var(--icon-control)" />
          </button>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!selectedDocId) return
            addMutation.mutate()
          }}
          style={{ display: 'grid', gap: 'var(--space-3)' }}
        >
          <label style={{ display: 'grid', gap: 'var(--space-1)' }}>
            <span style={{ fontSize: 'var(--text-label)', color: 'var(--muted)' }}>Select document *</span>
            <select
              value={selectedDocId}
              onChange={(e) => setSelectedDocId(e.target.value)}
              required
              style={{
                height: 'var(--control-height)',
                padding: '0 var(--space-3)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-control)',
                background: 'var(--surface-soft)',
                color: 'var(--text)',
              }}
            >
              <option value="">-- Choose a document --</option>
              {availableDocs.map((doc) => (
                <option key={doc.document_id} value={doc.document_id}>
                  {doc.title}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'grid', gap: 'var(--space-1)' }}>
            <span style={{ fontSize: 'var(--text-label)', color: 'var(--muted)' }}>Project Role</span>
            <select
              value={role}
              onChange={(e) => {
                const parsed = projectRoleSchema.safeParse(e.target.value)
                if (parsed.success) {
                  setRole(parsed.data)
                }
              }}
              style={{
                height: 'var(--control-height)',
                padding: '0 var(--space-3)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-control)',
                background: 'var(--surface-soft)',
                color: 'var(--text)',
              }}
            >
              {ROLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label} — {opt.description}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'grid', gap: 'var(--space-1)' }}>
            <span style={{ fontSize: 'var(--text-label)', color: 'var(--muted)' }}>
              Pinned Page (for PDFs, optional)
            </span>
            <input
              type="number"
              min="1"
              value={pinnedPage}
              onChange={(e) => setPinnedPage(e.target.value)}
              placeholder="e.g. 14"
              style={{
                height: 'var(--control-height)',
                padding: '0 var(--space-3)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-control)',
                background: 'var(--surface-soft)',
                color: 'var(--text)',
              }}
            />
          </label>

          <label style={{ display: 'grid', gap: 'var(--space-1)' }}>
            <span style={{ fontSize: 'var(--text-label)', color: 'var(--muted)' }}>
              Notes / Takeaways (optional)
            </span>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Primary literature reference for Section 3"
              style={{
                padding: 'var(--space-2) var(--space-3)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-control)',
                background: 'var(--surface-soft)',
                color: 'var(--text)',
                fontSize: 'var(--text-body)',
              }}
            />
          </label>

          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 'var(--space-2)',
              marginTop: 'var(--space-2)',
            }}
          >
            <button className="secondary-action" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={addMutation.isPending || !selectedDocId}
            >
              Add to Project
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
