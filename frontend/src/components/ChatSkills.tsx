import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2, AlertTriangle, Terminal, Sparkles, Check } from 'lucide-react'
import { api, writeFailureMessage, type SkillSummary } from '../api'
import { StateMessage } from './ui/StateMessage'

export function ChatSkills({ projectId }: { projectId?: string }) {
  const queryClient = useQueryClient()
  const [copiedSkill, setCopiedSkill] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const skillsQuery = useQuery({
    queryKey: ['chat-skills', projectId],
    queryFn: () => api.listChatSkills(projectId),
  })

  const unregisterMutation = useMutation({
    mutationFn: (skillId: string) => api.unregisterChatSkill(skillId),
    onSuccess: async () => {
      setErrorMessage(null)
      await queryClient.invalidateQueries({ queryKey: ['chat-skills'] })
    },
    onError: (error) => {
      setErrorMessage(writeFailureMessage(error, 'Could not unregister skill.'))
    },
  })

  const copySlashCommand = (name: string) => {
    navigator.clipboard.writeText(`/${name}`)
    setCopiedSkill(name)
    setTimeout(() => setCopiedSkill(null), 2000)
  }

  return (
    <div className="chat-skills-panel">
      <div className="chat-skills-header-intro">
        <p>
          Skills are reusable user-authored procedures defined in Markdown documents starting with standard
          YAML frontmatter (<code>name</code> and <code>description</code>).
        </p>
        <p>
          When a skill description matches your request, or when you explicitly type <code>/skill-name</code>{' '}
          in chat, the assistant loads its exact procedure and pinned resources.
        </p>
      </div>

      {errorMessage && (
        <StateMessage
          compact
          kind="error"
          title={errorMessage}
          action={
            <button className="secondary-action" onClick={() => setErrorMessage(null)}>
              Dismiss
            </button>
          }
        />
      )}

      {skillsQuery.isPending ? (
        <StateMessage compact kind="loading" title="Loading registered skills" />
      ) : skillsQuery.isError ? (
        <StateMessage compact kind="error" title="Could not load skills" />
      ) : !skillsQuery.data || skillsQuery.data.length === 0 ? (
        <div className="empty-skills-notice">
          <Sparkles size="var(--icon-page)" className="empty-skills-icon" />
          <p>
            <strong>No chat skills registered yet</strong>
          </p>
          <p className="dimmed">
            To register a skill, create a Markdown document starting with YAML frontmatter, then click
            &ldquo;Register as chat skill&rdquo; in the document properties panel.
          </p>
        </div>
      ) : (
        <div className="chat-skills-list">
          {skillsQuery.data.map((skill: SkillSummary) => (
            <article key={skill.skill_id} className={`chat-skill-card ${!skill.valid ? 'invalid' : ''}`}>
              <div className="chat-skill-header">
                <div className="chat-skill-title-group">
                  <h4 className="chat-skill-name">
                    <code>/{skill.name}</code>
                  </h4>
                  <span
                    className={`badge ${skill.origin === 'project' ? 'badge-project' : 'badge-personal'}`}
                  >
                    {skill.origin === 'project'
                      ? skill.project_id
                        ? `Project ${skill.project_id}`
                        : 'Project'
                      : 'Personal'}
                  </span>
                  {skill.has_scripts && (
                    <span
                      className="badge badge-warning"
                      title="Scripts declared in frontmatter are not supported in chat"
                    >
                      No script execution
                    </span>
                  )}
                </div>
                <div className="chat-skill-actions">
                  <button
                    className="secondary-action compact-button"
                    onClick={() => copySlashCommand(skill.name)}
                    title={`Copy /${skill.name}`}
                  >
                    {copiedSkill === skill.name ? (
                      <Check size="var(--icon-inline)" />
                    ) : (
                      <Terminal size="var(--icon-inline)" />
                    )}
                    {copiedSkill === skill.name ? 'Copied' : `/${skill.name}`}
                  </button>
                  <button
                    className="icon-button danger"
                    aria-label={`Unregister ${skill.name}`}
                    title="Unregister skill"
                    disabled={unregisterMutation.isPending}
                    onClick={() => unregisterMutation.mutate(skill.skill_id)}
                  >
                    <Trash2 size="var(--icon-control)" />
                  </button>
                </div>
              </div>

              <p className="chat-skill-description">{skill.description}</p>

              <div className="chat-skill-meta">
                <span className="dimmed-meta">
                  ID: <code>{skill.skill_id}</code>
                </span>
                <span className="dimmed-meta">
                  Doc: <code>{skill.document_id.slice(0, 8)}</code>
                </span>
              </div>

              {skill.diagnostics && skill.diagnostics.length > 0 && (
                <div className="chat-skill-diagnostics">
                  {skill.diagnostics.map((diag: string, i: number) => (
                    <div key={i} className="skill-diagnostic-item">
                      <AlertTriangle size="var(--icon-inline)" className="warning-icon" />
                      <span>{diag}</span>
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
