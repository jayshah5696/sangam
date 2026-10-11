import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type ChatMemoryEntry, type ChatMemoryChange } from '../api'
import { StateMessage } from './ui/StateMessage'

/** Facts share profile authority and revisions; they never duplicate standing instructions. */
export function ChatMemory({ projectId }: { projectId?: string }) {
  const queryClient = useQueryClient()
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['chat-memory'] })
    void queryClient.invalidateQueries({ queryKey: ['chat-profile-applied'] })
  }
  const [offset, setOffset] = useState(0)
  const [content, setContent] = useState('')
  const [scope, setScope] = useState('user')
  const memory = useQuery({
    queryKey: ['chat-memory', projectId, offset],
    queryFn: () => api.chatMemory(projectId, offset),
  })
  const create = useMutation({
    mutationFn: () =>
      api.changeChatMemory({
        memory_id: crypto.randomUUID(),
        project_id: scope === 'project' ? (projectId ?? null) : null,
        content,
        expected_version: 0,
        action: 'save',
        source_thread_id: null,
        source_item_id: null,
      }),
    onSuccess: () => {
      setContent('')
      setOffset(0)
      refresh()
    },
  })
  return (
    <details>
      <summary>Saved facts</summary>
      <p>
        Facts provide context when relevant. Keep preferences in Instructions above. Forgetting stops future
        recall. Original conversations and past run evidence remain; delete a conversation separately to
        remove its transcript.
      </p>
      <details>
        <summary>Add fact</summary>
        <label className="settings-field">
          Fact to remember
          <textarea
            rows={3}
            maxLength={2000}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        </label>
        {projectId && (
          <label className="settings-field">
            Fact scope
            <select value={scope} onChange={(event) => setScope(event.target.value)}>
              <option value="user">Personal</option>
              <option value="project">Selected project</option>
            </select>
          </label>
        )}
        <button
          className="primary-button"
          disabled={create.isPending || !content.trim()}
          onClick={() => create.mutate()}
        >
          Save fact
        </button>
        {content && (
          <button
            className="secondary-action"
            disabled={create.isPending}
            onClick={() => {
              setContent('')
              create.reset()
            }}
          >
            Discard new fact
          </button>
        )}
        {create.isError && <StateMessage compact kind="error" title="Fact could not be saved" />}
        {create.isSuccess && (
          <StateMessage
            compact
            kind="success"
            title="Fact saved"
            action={
              <button className="secondary-action" onClick={() => create.reset()}>
                Dismiss notification
              </button>
            }
          />
        )}
      </details>
      {memory.isPending ? (
        <StateMessage compact kind="loading" title="Loading saved facts" />
      ) : memory.isError && !memory.data ? (
        <StateMessage compact kind="error" title="Saved facts could not be loaded" />
      ) : (
        memory.data && (
          <>
            {memory.data.entries.length === 0 && <StateMessage compact kind="empty" title="No saved facts" />}
            {memory.data.entries.map((entry) => (
              <MemoryEditor
                key={`${entry.project_id ?? 'user'}:${entry.memory_id}`}
                entry={entry}
                onReload={async () => {
                  const result = await memory.refetch()
                  return result.isSuccess
                    ? result.data.entries.find(
                        (saved) =>
                          saved.memory_id === entry.memory_id && saved.project_id === entry.project_id,
                      )
                    : undefined
                }}
                onChanged={() => {
                  refresh()
                }}
              />
            ))}
            <div className="chat-effect-actions">
              {offset > 0 && (
                <button className="secondary-action" onClick={() => setOffset(offset - 10)}>
                  Previous facts
                </button>
              )}
              {memory.data.has_more && (
                <button className="secondary-action" onClick={() => setOffset(offset + 10)}>
                  Next facts
                </button>
              )}
            </div>
          </>
        )
      )}
      {memory.isError && memory.data && (
        <StateMessage
          compact
          kind="error"
          title="Saved facts could not be refreshed"
          description="Your draft is preserved."
        />
      )}
    </details>
  )
}

function MemoryEditor({
  entry,
  onChanged,
  onReload,
}: {
  entry: ChatMemoryEntry
  onChanged: () => void
  onReload: () => Promise<ChatMemoryEntry | undefined>
}) {
  const [baseline, setBaseline] = useState(entry)
  const [content, setContent] = useState(entry.content)
  const [open, setOpen] = useState(false)
  const editButton = useRef<HTMLButtonElement>(null)
  const [forget, setForget] = useState(false)
  const dirty = content !== baseline.content
  // Refresh clean rows, but a draft keeps the revision against which it was written.
  if (entry.version > baseline.version && !dirty) {
    setBaseline(entry)
    setContent(entry.content)
  }
  const update = useMutation({
    mutationFn: (action: ChatMemoryChange['action']) =>
      api.changeChatMemory({
        memory_id: entry.memory_id,
        project_id: entry.project_id,
        expected_version: baseline.version,
        action,
        content: action === 'forget' ? '' : action === 'accept' ? entry.content : content,
        source_thread_id: entry.source_thread_id,
        source_item_id: entry.source_item_id,
      }),
    onSuccess: (saved) => {
      setBaseline(saved)
      setContent(saved.content)
      setOpen(false)
      setForget(false)
      editButton.current?.focus()
      onChanged()
    },
  })
  const conflict = update.error instanceof ApiError && update.error.status === 409
  return (
    <section className="chat-memory-row">
      <p>
        <strong>{entry.state === 'suggested' ? 'Suggested fact' : 'Saved fact'}</strong> ·{' '}
        {entry.project_id ? `Project ${entry.project_id}` : 'Personal'} · version {entry.version}
      </p>
      <p className="chat-memory-preview" title={entry.content}>
        {entry.content}
      </p>
      <button
        ref={editButton}
        className="secondary-action"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Edit fact
      </button>
      {dirty && <span> Unsaved changes</span>}
      {update.isError && <span role="status"> Changes not saved</span>}
      <div hidden={!open}>
        <p className="instruction-content">ID: {entry.memory_id}</p>
        <label className="settings-field">
          Edit fact
          <textarea
            rows={3}
            maxLength={2000}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        </label>
        <p className="instruction-content">
          {entry.source_thread_id
            ? `Source conversation: ${entry.source_thread_id}${entry.source_item_id ? ` · message ${entry.source_item_id}` : ''}`
            : 'Source: direct edit'}
        </p>
        <div className="chat-effect-actions">
          <button
            className="secondary-action"
            disabled={update.isPending}
            onClick={() => {
              setOpen(false)
              setForget(false)
              editButton.current?.focus()
            }}
          >
            Close fact editor
          </button>
          {dirty && (
            <button
              className="secondary-action"
              disabled={update.isPending}
              onClick={() => {
                setContent(baseline.content)
                update.reset()
              }}
            >
              Discard fact changes
            </button>
          )}
          <button
            className="primary-button"
            disabled={update.isPending || !content.trim()}
            onClick={() => update.mutate(entry.state === 'suggested' ? 'suggest' : 'save')}
          >
            Save fact changes
          </button>
          {entry.state === 'suggested' && (
            <button
              className="secondary-action"
              disabled={update.isPending}
              onClick={() => update.mutate('accept')}
            >
              Accept suggestion
            </button>
          )}
          <button className="secondary-action" onClick={() => setForget(true)}>
            {entry.state === 'suggested' ? 'Dismiss suggestion' : 'Forget fact'}
          </button>
        </div>
        {forget && (
          <div role="group" aria-label="Confirm forgetting">
            <p>Stop recalling this fact? The original conversation remains.</p>
            <div className="chat-effect-actions">
              <button className="secondary-action" onClick={() => setForget(false)}>
                Keep fact
              </button>
              <button
                className="primary-button"
                disabled={update.isPending}
                onClick={() => update.mutate('forget')}
              >
                Confirm forget
              </button>
            </div>
          </div>
        )}
        {update.isError && (
          <>
            <StateMessage
              compact
              kind="error"
              title={conflict ? 'Memory changed elsewhere' : 'Memory could not be changed'}
              description="Your draft is preserved. Reload saved facts before trying again."
            />
            <button
              className="secondary-action"
              onClick={async () => {
                const saved = await onReload()
                if (saved) {
                  setBaseline(saved)
                  setContent(saved.content)
                  update.reset()
                }
              }}
            >
              Reload saved facts
            </button>
          </>
        )}
      </div>
    </section>
  )
}
