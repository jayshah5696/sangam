import { useState } from 'react'
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
      {create.isError && <StateMessage kind="error" title="Fact could not be saved" />}
      {create.isSuccess && <StateMessage kind="success" title="Fact saved" />}
      {memory.isPending ? (
        <StateMessage kind="loading" title="Loading saved facts" />
      ) : memory.isError ? (
        <StateMessage kind="error" title="Saved facts could not be loaded" />
      ) : (
        <>
          {memory.data.entries.length === 0 && <StateMessage kind="empty" title="No saved facts" />}
          {memory.data.entries.map((entry) => (
            <MemoryEditor
              key={`${entry.project_id ?? 'user'}:${entry.memory_id}:${entry.version}`}
              entry={entry}
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
      )}
    </details>
  )
}

function MemoryEditor({ entry, onChanged }: { entry: ChatMemoryEntry; onChanged: () => void }) {
  const [content, setContent] = useState(entry.content)
  const [forget, setForget] = useState(false)
  const update = useMutation({
    mutationFn: (action: ChatMemoryChange['action']) =>
      api.changeChatMemory({
        memory_id: entry.memory_id,
        project_id: entry.project_id,
        expected_version: entry.version,
        action,
        content: action === 'forget' ? '' : action === 'accept' ? entry.content : content,
        source_thread_id: entry.source_thread_id,
        source_item_id: entry.source_item_id,
      }),
    onSuccess: onChanged,
  })
  const conflict = update.error instanceof ApiError && update.error.status === 409
  return (
    <section>
      <p>
        <strong>{entry.state === 'suggested' ? 'Suggested fact' : 'Saved fact'}</strong> ·{' '}
        {entry.project_id ? `Project ${entry.project_id}` : 'Personal'} · version {entry.version}
      </p>
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
            kind="error"
            title={conflict ? 'Memory changed elsewhere' : 'Memory could not be changed'}
            description="Your draft is preserved. Reload saved facts before trying again."
          />
          <button className="secondary-action" onClick={onChanged}>
            Reload saved facts
          </button>
        </>
      )}
    </section>
  )
}
