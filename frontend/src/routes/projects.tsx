import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  ExternalLink,
  FileStack,
  FileText,
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
    <section className="projects-page">
      <header className="projects-header">
        <div className="projects-header-info">
          <div className="projects-eyebrow">
            <FolderKanban size="var(--icon-detail)" />
            <span>Workspace Initiatives</span>
          </div>
          <div className="projects-title-row">
            <h1>Projects</h1>
            {projectsQuery.data && (
              <span className="projects-count-pill">{projectsQuery.data.length} active</span>
            )}
          </div>
          <p className="projects-description">
            Persistent workspaces for research initiatives, writing efforts, and investigations with linked
            sources, automated briefs, and workbench layout recall.
          </p>
        </div>

        <div>
          <button className="primary-button" type="button" onClick={() => setShowCreateModal(true)}>
            <Plus size="var(--icon-control)" /> New Project
          </button>
        </div>
      </header>

      <div className="projects-toolbar">
        <div className="projects-search-bar">
          <Search size="var(--icon-detail)" className="projects-search-icon" />
          <input
            className="projects-search-input"
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter projects by title or description…"
            aria-label="Filter projects"
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

      <div className="projects-grid">
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
    <article className="project-card-outer">
      <div className="project-card-inner">
        <div className="project-card-header">
          <div className="project-badge-icon">
            <FolderKanban size="var(--icon-inline)" />
          </div>
          <div className="project-card-title-group">
            <button
              type="button"
              className="project-card-title-button"
              onClick={onOpen}
              title={project.name}
            >
              {project.name}
            </button>
            <div className="project-card-meta">
              <span>Updated {new Date(project.updated_at).toLocaleDateString()}</span>
            </div>
          </div>
        </div>

        {project.description ? (
          <p className="project-card-description">{project.description}</p>
        ) : (
          <p className="project-card-description" style={{ fontStyle: 'italic', opacity: 0.6 }}>
            No project description provided.
          </p>
        )}

        <div className="project-card-stats-row">
          {project.brief_document_id && (
            <span className="project-stat-pill has-brief" title="Brief document attached">
              <BookOpen size="var(--icon-detail)" />
              <span>{project.brief_document_title ?? 'Brief'}</span>
            </span>
          )}
          <span className="project-stat-pill">
            <FileText size="var(--icon-detail)" />
            <span>
              {project.document_count} {project.document_count === 1 ? 'doc' : 'docs'}
            </span>
          </span>
          {project.thread_count > 0 && (
            <span className="project-stat-pill">
              <MessageSquare size="var(--icon-detail)" />
              <span>
                {project.thread_count} {project.thread_count === 1 ? 'thread' : 'threads'}
              </span>
            </span>
          )}

        </div>

        <div className="project-card-footer">
          <button
            className="primary-button project-resume-btn"
            type="button"
            onClick={() => void resumeProject()}
            title="Resume workbench layout and open documents"
          >
            <Layout size="var(--icon-control)" /> Resume
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
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
        </div>
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
      <section className="projects-page">
        <StateMessage kind="loading" title="Loading project details…" />
      </section>
    )
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <section className="projects-page">
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
    <section className="projects-page">
      <div className="project-detail-back-bar">
        <button className="secondary-action" type="button" onClick={onBack}>
          <ArrowLeft size="var(--icon-inline)" /> Back to projects
        </button>
      </div>

      <header className="project-detail-hero">
        <div className="project-detail-hero-top">
          <div className="project-detail-title-block">
            <div className="projects-eyebrow">
              <FolderKanban size="var(--icon-detail)" />
              <span>Project Initiative</span>
            </div>

            {isEditing ? (
              <div style={{ display: 'grid', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="project-modal-input"
                  style={{ fontSize: 'var(--text-title-sm)', fontWeight: 600 }}
                />
                <textarea
                  rows={2}
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="project-modal-textarea"
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                  <h1>{project.name}</h1>
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
                  <p className="projects-description">{project.description}</p>
                )}
              </div>
            )}
          </div>

          <div className="project-detail-actions">
            <button
              className="primary-button project-detail-hero-resume-btn"
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
        </div>
      </header>

      <div className="project-detail-grid">
        <div className="project-detail-main">
          {/* Brief Card */}
          <section className="project-section-panel">
            <div className="project-section-header">
              <h2>
                <BookOpen size="var(--icon-inline)" /> Project Brief
              </h2>
              {project.brief_document_id && (
                <Link
                  to="/documents/$documentId"
                  params={{ documentId: project.brief_document_id }}
                  className="secondary-action"
                  style={{ fontSize: 'var(--text-meta)', display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}
                >
                  <span>Open brief in editor</span>
                  <ExternalLink size="var(--icon-detail)" />
                </Link>
              )}
            </div>

            <div className="project-section-body">
              {project.brief_document_id ? (
                <div className="project-brief-artifact">
                  <div className="project-brief-artifact-info">
                    <p className="project-brief-artifact-title">
                      {project.brief_document_title ?? 'Project Brief'}
                    </p>
                    <p className="project-brief-artifact-desc">
                      Ordinary Markdown brief holding scope, background, open questions, and deliverables.
                    </p>
                  </div>
                  <span className="project-role-badge role-draft">Draft Brief</span>
                </div>
              ) : (
                <p style={{ color: 'var(--muted)', margin: 0, fontSize: 'var(--text-meta)' }}>
                  No brief linked yet. You can set any document as the project brief.
                </p>
              )}
            </div>
          </section>

          {/* Documents & Sources Section */}
          <section className="project-section-panel">
            <div className="project-section-header">
              <div className="project-section-header-info">
                <h2>
                  <FileStack size="var(--icon-inline)" /> Documents & Research Sources
                </h2>
                <p>
                  Documents belong to this project by reference. One document can support multiple projects.
                </p>
              </div>

              <button className="secondary-action" type="button" onClick={() => setShowAddDocModal(true)}>
                <Plus size="var(--icon-control)" /> Add document
              </button>
            </div>

            <div className="project-section-body">
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
                <div className="project-doc-table">
                  {project.documents.map((doc) => (
                    <article key={doc.document_id} className="project-doc-row">
                      <div className="project-doc-main">
                        <div className="project-doc-title-row">
                          <button
                            type="button"
                            className="project-doc-title-btn"
                            onClick={() => {
                              workbench.ensureDocumentOpen(doc.document_id, doc.document_title)
                              void navigate({
                                to: '/documents/$documentId',
                                params: { documentId: doc.document_id },
                              })
                            }}
                          >
                            {doc.document_title}
                          </button>
                          <code className="project-doc-path">{doc.document_path}</code>
                        </div>

                        {doc.notes && <p className="project-doc-notes">{doc.notes}</p>}

                        <div className="project-doc-badges">
                          <span className={`project-role-badge role-${doc.role}`}>{doc.role}</span>
                          {doc.pinned_page && (
                            <span className="project-page-badge">
                              <BookOpen size="var(--icon-detail)" /> Page {doc.pinned_page}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="project-doc-actions">
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
            </div>
          </section>
        </div>

        <div className="project-detail-sidebar">
          {/* Workbench Context Layout Status */}
          <section className="project-section-panel">
            <div className="project-section-header">
              <h2>
                <Layout size="var(--icon-inline)" /> Workbench Context
              </h2>
            </div>
            <div className="project-section-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
              <p style={{ margin: 0, fontSize: 'var(--text-meta)', color: 'var(--muted)', lineHeight: 'var(--leading-body)' }}>
                {project.workbench_state_json
                  ? 'Active workbench layout snapshot is saved. Resuming this project restores your splits, active editors, and documents.'
                  : 'No layout snapshot saved yet. Click "Snapshot current layout" in the header to remember your current workbench arrangement.'}
              </p>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <button
                  className="secondary-action"
                  type="button"
                  style={{ width: '100%' }}
                  onClick={handleSaveCurrentLayout}
                  disabled={updateMutation.isPending}
                >
                  <Save size="var(--icon-control)" /> Snapshot Now
                </button>
              </div>
            </div>
          </section>

          {/* Relevant Chat Threads */}
          <section className="project-section-panel">
            <div className="project-section-header">
              <h2>
                <MessageSquare size="var(--icon-inline)" /> Relevant Chat Threads
              </h2>
            </div>
            <div className="project-section-body">
              {project.threads.length === 0 ? (
                <p style={{ color: 'var(--muted)', fontSize: 'var(--text-meta)', fontStyle: 'italic', margin: 0 }}>
                  No chat threads linked yet. Link threads from Workspace Chat to keep your conversations attached.
                </p>
              ) : (
                <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
                  {project.threads.map((t) => (
                    <div key={t.thread_id} className="project-doc-row" style={{ padding: 'var(--space-2) var(--space-3)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                        <MessageSquare size="var(--icon-inline)" />
                        <span style={{ fontWeight: 500, fontSize: 'var(--text-control)' }}>
                          {t.title ?? 'Conversation'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

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
    <div className="project-modal-overlay">
      <div className="project-modal-dialog">
        <header className="project-modal-header">
          <h2>Create Project</h2>
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
          className="project-modal-form"
        >
          <label className="project-modal-field">
            <span className="project-modal-label">Project name *</span>
            <input
              type="text"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Distributed Consensus Investigation"
              className="project-modal-input"
            />
          </label>

          <label className="project-modal-field">
            <span className="project-modal-label">Purpose & Goals (optional)</span>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What questions is this project answering? What are the deliverables?"
              className="project-modal-textarea"
            />
          </label>

          <div className="project-modal-actions">
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
    <div className="project-modal-overlay">
      <div className="project-modal-dialog">
        <header className="project-modal-header">
          <h2>Add Document to Project</h2>
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
          className="project-modal-form"
        >
          <label className="project-modal-field">
            <span className="project-modal-label">Select document *</span>
            <select
              value={selectedDocId}
              onChange={(e) => setSelectedDocId(e.target.value)}
              required
              className="project-modal-select"
              aria-label="Select document"
            >
              <option value="">-- Choose a document --</option>
              {availableDocs.map((doc) => (
                <option key={doc.document_id} value={doc.document_id}>
                  {doc.title}
                </option>
              ))}
            </select>
          </label>

          <div className="project-modal-field">
            <label htmlFor="project-role-select" className="project-modal-label">
              Project Role
            </label>
            <div className="project-role-pills-row">
              {ROLE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`project-role-choice-pill ${role === opt.value ? 'active' : ''}`}
                  onClick={() => setRole(opt.value)}
                  title={opt.description}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <select
              id="project-role-select"
              value={role}
              onChange={(e) => {
                const parsed = projectRoleSchema.safeParse(e.target.value)
                if (parsed.success) {
                  setRole(parsed.data)
                }
              }}
              className="project-modal-select"
            >
              {ROLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label} — {opt.description}
                </option>
              ))}
            </select>
          </div>

          <label className="project-modal-field">
            <span className="project-modal-label">Pinned Page (for PDFs, optional)</span>
            <input
              type="number"
              min="1"
              value={pinnedPage}
              onChange={(e) => setPinnedPage(e.target.value)}
              placeholder="e.g. 14"
              className="project-modal-input"
            />
          </label>

          <label className="project-modal-field">
            <span className="project-modal-label">Notes / Takeaways (optional)</span>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Primary literature reference for Section 3"
              className="project-modal-textarea"
            />
          </label>

          <div className="project-modal-actions">
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
