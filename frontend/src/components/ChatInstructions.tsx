import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api, ApiError, type ChatProfileEntry } from '../api'
import { StateMessage } from './ui/StateMessage'

/** One profile editor for both sources; the override is local to the next submitted turn. */
export function ChatInstructions({
  projectId,
  threadId,
  override,
  onOverrideChange,
}: {
  projectId?: string
  threadId: string | null
  override: string
  onOverrideChange: (value: string) => void
}) {
  const [savedMessage, setSavedMessage] = useState('')
  const profile = useQuery({
    queryKey: ['chat-profile', projectId],
    queryFn: () => api.chatProfile(projectId),
  })
  const applied = useQuery({
    queryKey: ['chat-profile-applied', threadId],
    queryFn: () => api.chatProfile(undefined, threadId ?? undefined),
    enabled: Boolean(threadId),
  })
  return (
    <details className="chat-instructions">
      <summary>Instructions</summary>
      <p>
        Personal preferences and the selected project's instructions guide chat. Your latest request takes
        precedence. Permissions and approvals stay enforced.
      </p>
      <p>{projectId ? `Selected project: ${projectId}` : 'No project selected'}</p>
      {profile.isPending ? (
        <StateMessage kind="loading" title="Loading instructions" />
      ) : profile.isError ? (
        <StateMessage kind="error" title="Instructions could not be loaded" />
      ) : (
        profile.data.entries.map((entry) => (
          <ProfileEditor
            key={`${entry.project_id ?? 'user'}:${entry.version}`}
            entry={entry}
            onSaved={(message) => {
              setSavedMessage(message ?? '')
              void profile.refetch()
            }}
          />
        ))
      )}
      {savedMessage && <StateMessage kind="success" title={savedMessage} />}
      <label className="settings-field">
        Next turn only
        <textarea
          maxLength={2000}
          rows={3}
          value={override}
          onChange={(event) => onOverrideChange(event.target.value)}
        />
      </label>
      <p>This override clears after your next message is sent. It does not change saved instructions.</p>
      {applied.data && applied.data.entries.length > 0 && (
        <details>
          <summary>Applied to the latest turn</summary>
          {applied.data.entries.map((entry) => (
            <p key={entry.project_id ?? 'user'}>
              <strong>
                {entry.project_id ? `Project ${entry.project_id}` : 'Personal'} · version {entry.version}
              </strong>
              <span className="instruction-content">{entry.content || 'No saved instructions'}</span>
            </p>
          ))}
          {applied.data.instructions_override && <p>Turn override: {applied.data.instructions_override}</p>}
        </details>
      )}
    </details>
  )
}

function ProfileEditor({ entry, onSaved }: { entry: ChatProfileEntry; onSaved: (message?: string) => void }) {
  const [content, setContent] = useState(entry.content)
  const scope = entry.project_id ? 'project' : 'personal'
  const title = entry.project_id ? 'Project instructions' : 'Personal instructions'
  const save = useMutation({
    mutationFn: (value: string) => api.saveChatProfile(entry, value),
    onSuccess: () => onSaved(`${title} saved`),
  })
  const conflict = save.error instanceof ApiError && save.error.status === 409
  return (
    <section>
      <label className="settings-field">
        {title}
        <textarea
          maxLength={4000}
          rows={4}
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
      </label>
      <div className="chat-effect-actions">
        <button className="primary-button" disabled={save.isPending} onClick={() => save.mutate(content)}>
          Save {scope} instructions
        </button>
        <button className="secondary-action" disabled={save.isPending} onClick={() => save.mutate('')}>
          Clear {scope} instructions
        </button>
      </div>
      {save.isError && (
        <>
          <StateMessage
            kind="error"
            title={conflict ? 'Instructions changed elsewhere' : 'Instructions could not be saved'}
            description={
              conflict
                ? 'Your draft is preserved. Reload the saved instructions before making another change.'
                : undefined
            }
          />
          <button className="secondary-action" onClick={() => onSaved()}>
            Reload saved instructions
          </button>
        </>
      )}
    </section>
  )
}
