import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { api, type ProjectSummary } from '../../api'
import { StateMessage } from '../ui/StateMessage'
import { projectDraft, useProjectResume } from '../../projectResume'
import { CreateProjectDialog } from '../../routes/projects'
import { ProjectBriefing, ProjectReviews } from './ProjectAssignments'

export function ProjectHome({
  projects,
  selectedId,
  onSelect,
}: {
  projects: ProjectSummary[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  const [creating, setCreating] = useState(false)
  const { resume, openDocument } = useProjectResume()
  const project = useQuery({
    queryKey: ['project', selectedId],
    queryFn: () => api.getProject(selectedId),
    enabled: Boolean(selectedId),
    refetchOnMount: 'always',
  })
  const proposals = useQuery({
    queryKey: ['chat-proposals', 'workspace-review'],
    queryFn: () => api.listChatProposals(),
  })
  const resumeMutation = useMutation({ mutationFn: () => api.getProject(selectedId).then(resume) })
  const detail = project.data
  const draft = detail ? projectDraft(detail) : undefined
  const reviewable = (proposals.data ?? []).filter((p) => p.status === 'pending' || p.status === 'stale')
  const projectReviews = reviewable.filter(
    (p) =>
      detail?.documents.some((d) => d.document_id === p.document_id) ||
      detail?.threads.some((t) => t.thread_id === p.thread_id),
  )
  const workspaceReviews = reviewable.filter(
    (p) => !projectReviews.some((r) => r.proposal_id === p.proposal_id),
  )
  const sources = detail?.documents.filter((d) => d.role === 'source' && d.source_updated) ?? []
  const attention = (items: typeof reviewable) => {
    const pending = items.filter((p) => p.status === 'pending').length
    const stale = items.filter((p) => p.status === 'stale').length
    return `${pending} proposed ${pending === 1 ? 'change' : 'changes'} to review${stale ? ` · ${stale} stale ${stale === 1 ? 'change needs' : 'changes need'} a fresh revision` : ''}`
  }
  return (
    <div className="project-home">
      <header className="project-home-toolbar">
        <label>
          Switch project
          <select value={selectedId} onChange={(e) => onSelect(e.target.value)}>
            <option value="">Workspace</option>
            {projects.map((p) => (
              <option key={p.project_id} value={p.project_id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button className="secondary-action" onClick={() => setCreating(true)}>
          New Project
        </button>
        {selectedId && (
          <Link className="secondary-action" to="/projects" search={{ project: selectedId }}>
            Manage project
          </Link>
        )}
      </header>
      {selectedId && project.isPending && (
        <StateMessage compact kind="loading" title="Loading ongoing work" />
      )}
      {project.isError && (
        <StateMessage
          compact
          kind="error"
          title="Could not load selected project"
          description={project.error.message}
          action={<button onClick={() => void project.refetch()}>Retry</button>}
        />
      )}
      {detail && (
        <section className="project-home-resume" aria-label="Resume next action">
          <div>
            <h2>{draft?.document_title ?? 'Choose the next step'}</h2>
            {draft?.excerpt && <p className="project-home-excerpt">{draft.excerpt}</p>}
            <p>
              {draft
                ? `Continue the draft${detail.documents.some((d) => d.role === 'source') ? ' beside your saved sources' : ''}${detail.active_thread_id ? ' and conversation' : ''}.`
                : 'Attach a draft or source, or create a document below.'}
            </p>
            {detail.documents
              .filter((d) => d.role === 'source' && d.pinned_page)
              .map((d) => (
                <span key={d.document_id}>
                  {d.document_title} · Page {d.pinned_page}{' '}
                </span>
              ))}
          </div>
          {draft ? (
            <button
              className="primary-button"
              disabled={resumeMutation.isPending}
              onClick={() => resumeMutation.mutate()}
            >
              Resume draft
            </button>
          ) : detail.active_thread_id ? (
            <button className="primary-button" onClick={() => resumeMutation.mutate()}>
              Resume conversation
            </button>
          ) : (
            <Link className="primary-button" to="/projects" search={{ project: detail.project_id }}>
              Add sources or a draft
            </Link>
          )}
        </section>
      )}
      {resumeMutation.isError && (
        <StateMessage
          compact
          kind="error"
          title="Could not resume project"
          description={resumeMutation.error.message}
        />
      )}
      {proposals.isError && (
        <StateMessage
          compact
          kind="error"
          title="Could not load review attention"
          description={proposals.error.message}
          action={<button onClick={() => void proposals.refetch()}>Retry</button>}
        />
      )}
      {detail && (
        <ProjectBriefing
          key={`briefing-${detail.project_id}`}
          project={detail}
          reviews={{
            pending: projectReviews.filter((p) => p.status === 'pending').length,
            stale: projectReviews.filter((p) => p.status === 'stale').length,
          }}
          updatedSources={sources}
          onOpenDocument={(d) => void openDocument(d, undefined, selectedId)}
        />
      )}
      {workspaceReviews.length > 0 && (
        <section className="project-home-attention" aria-label="Workspace attention">
          <h2>Workspace attention</h2>
          <Link to="/review">{attention(workspaceReviews)}</Link>
        </section>
      )}
      {detail && (
        <div className="project-home-categories" aria-label="Project documents">
          {(['source', 'draft', 'note', 'decision', 'output'] as const).map((role) => {
            const docs = detail.documents.filter(
              (d) => d.role === role && d.document_id !== detail.brief_document_id,
            )
            if (!docs.length) return null
            const label = {
              source: 'Sources',
              draft: 'Drafts',
              note: 'Notes',
              decision: 'Decisions',
              output: 'Outputs',
            }[role]
            return (
              <section key={role}>
                <h2>{label}</h2>
                {docs.map((d) => (
                  <button
                    key={d.document_id}
                    className="project-home-document"
                    onClick={() => void openDocument(d, undefined, selectedId)}
                  >
                    <span>{d.document_title}</span>
                    <small>{d.notes ?? d.excerpt}</small>
                  </button>
                ))}
              </section>
            )
          })}
        </div>
      )}
      {detail && <ProjectReviews key={`reviews-${detail.project_id}`} project={detail} />}
      {creating && (
        <CreateProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false)
            onSelect(p.project_id)
          }}
        />
      )}
    </div>
  )
}
