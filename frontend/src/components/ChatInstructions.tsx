import { useCallback, useId, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api, ApiError, type ChatProfileEntry } from '../api'
import { StateMessage } from './ui/StateMessage'
import { ChatMemory } from './ChatMemory'
import { ModalDialog } from './ui/ModalDialog'

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
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'instructions' | 'facts'>('instructions')
  const contextId = useId()
  const close = useCallback(() => setOpen(false), [])
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
    <>
      <div className="chat-context-controls">
        <button className="secondary-action" aria-haspopup="dialog" onClick={() => setOpen(true)}>
          Instructions
        </button>
        <span>{override ? 'Next-turn override ready' : 'Instructions and saved facts'}</span>
      </div>
      <ModalDialog title="Chat context" className="chat-instructions" open={open} onClose={close}>
        <button className="secondary-action" onClick={close}>
          Close chat context
        </button>
        <div className="chat-context-tabs" role="tablist" aria-label="Chat context sections">
          {(['instructions', 'facts'] as const).map((value) => (
            <button
              key={value}
              id={`${contextId}-${value}-tab`}
              className="secondary-action"
              role="tab"
              aria-selected={tab === value}
              aria-controls={`${contextId}-${value}`}
              tabIndex={tab === value ? 0 : -1}
              onClick={() => setTab(value)}
              onKeyDown={(event) => {
                if (
                  event.key === 'ArrowLeft' ||
                  event.key === 'ArrowRight' ||
                  event.key === 'Home' ||
                  event.key === 'End'
                ) {
                  event.preventDefault()
                  const next =
                    event.key === 'Home'
                      ? 'instructions'
                      : event.key === 'End'
                        ? 'facts'
                        : value === 'instructions'
                          ? 'facts'
                          : 'instructions'
                  setTab(next)
                  document.getElementById(`${contextId}-${next}-tab`)?.focus()
                }
              }}
            >
              {value === 'instructions' ? 'Instructions' : 'Saved facts'}
            </button>
          ))}
        </div>
        <div
          id={`${contextId}-instructions`}
          role="tabpanel"
          aria-labelledby={`${contextId}-instructions-tab`}
          hidden={tab !== 'instructions'}
        >
          <p>
            Personal preferences and the selected project's instructions guide chat. Your latest request takes
            precedence. Permissions and approvals stay enforced.
          </p>
          <p>{projectId ? `Selected project: ${projectId}` : 'No project selected'}</p>
          {profile.isPending ? (
            <StateMessage compact kind="loading" title="Loading instructions" />
          ) : profile.isError && !profile.data ? (
            <StateMessage compact kind="error" title="Instructions could not be loaded" />
          ) : (
            profile.data?.entries.map((entry) => (
              <ProfileEditor
                key={entry.project_id ?? 'user'}
                entry={entry}
                onReload={async () => {
                  const result = await profile.refetch()
                  return result.isSuccess
                    ? result.data.entries.find((saved) => saved.project_id === entry.project_id)
                    : undefined
                }}
                onSaved={(message) => {
                  setSavedMessage(message ?? '')
                  void profile.refetch()
                }}
              />
            ))
          )}
          {profile.isError && profile.data && (
            <StateMessage
              compact
              kind="error"
              title="Instructions could not be refreshed"
              description="Your draft is preserved."
            />
          )}
          {savedMessage && (
            <StateMessage
              compact
              kind="success"
              title={savedMessage}
              action={
                <button className="secondary-action" onClick={() => setSavedMessage('')}>
                  Dismiss notification
                </button>
              }
            />
          )}
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
          {override && (
            <button className="secondary-action" onClick={() => onOverrideChange('')}>
              Discard next-turn override
            </button>
          )}
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
              {applied.data.instructions_override && (
                <p>Turn override: {applied.data.instructions_override}</p>
              )}
              {applied.data.memories.map((entry) => (
                <p key={`${entry.project_id ?? 'user'}:${entry.memory_id}`}>
                  <strong>
                    Saved fact {entry.memory_id} · version {entry.version}
                  </strong>
                  <span className="instruction-content">{entry.content}</span>
                </p>
              ))}
              <p>Corrected or forgotten facts are omitted from this current memory view.</p>
            </details>
          )}
        </div>
        <div
          id={`${contextId}-facts`}
          role="tabpanel"
          aria-labelledby={`${contextId}-facts-tab`}
          hidden={tab !== 'facts'}
        >
          <ChatMemory projectId={projectId} />
        </div>
      </ModalDialog>
    </>
  )
}

function ProfileEditor({
  entry,
  onSaved,
  onReload,
}: {
  entry: ChatProfileEntry
  onSaved: (message?: string) => void
  onReload: () => Promise<ChatProfileEntry | undefined>
}) {
  const [baseline, setBaseline] = useState(entry)
  const [content, setContent] = useState(entry.content)
  const dirty = content !== baseline.content
  if (entry.version > baseline.version && !dirty) {
    setBaseline(entry)
    setContent(entry.content)
  }
  const scope = entry.project_id ? 'project' : 'personal'
  const title = entry.project_id ? 'Project instructions' : 'Personal instructions'
  const save = useMutation({
    mutationFn: (value: string) => api.saveChatProfile(baseline, value),
    onSuccess: (saved) => {
      setBaseline(saved)
      setContent(saved.content)
      onSaved(`${title} saved`)
    },
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
        {dirty && (
          <button
            className="secondary-action"
            disabled={save.isPending}
            onClick={() => {
              setContent(baseline.content)
              save.reset()
            }}
          >
            Discard {scope} instruction changes
          </button>
        )}
      </div>
      {save.isError && (
        <>
          <StateMessage
            compact
            kind="error"
            title={conflict ? 'Instructions changed elsewhere' : 'Instructions could not be saved'}
            description={
              conflict
                ? 'Your draft is preserved. Reload the saved instructions before making another change.'
                : undefined
            }
          />
          <button
            className="secondary-action"
            onClick={async () => {
              const saved = await onReload()
              if (saved) {
                setBaseline(saved)
                setContent(saved.content)
                save.reset()
              }
            }}
          >
            Reload saved instructions
          </button>
        </>
      )}
    </section>
  )
}
