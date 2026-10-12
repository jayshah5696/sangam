import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type TaskNote, type TaskState } from '../api'
import { StateMessage } from './ui/StateMessage'

/** Task context stays in the context dialog; opening it never resumes work. */
export function ChatTask({
  threadId,
  sourceMessageId,
}: {
  threadId: string | null
  sourceMessageId?: string
}) {
  const query = useQuery({
    queryKey: ['chat-task', threadId],
    queryFn: () => api.chatTask(threadId ?? ''),
    enabled: Boolean(threadId),
  })
  const refresh = useRef<HTMLButtonElement>(null)
  if (!threadId) return <StateMessage compact kind="empty" title="Start a conversation first" />
  if (query.isPending) return <StateMessage compact kind="loading" title="Loading active task" />
  if (query.isError && !query.data)
    return (
      <StateMessage
        compact
        kind="error"
        title="Active task could not be loaded"
        action={
          <button className="secondary-action" onClick={() => void query.refetch()}>
            Retry task summary
          </button>
        }
      />
    )
  const state = query.data
  if (!state) return null
  return (
    <div>
      {sourceMessageId && (
        <TaskSource key={sourceMessageId} threadId={threadId} itemId={sourceMessageId} initiallyOpen />
      )}
      <p>
        Task context · version {state.version}. This summary can be wrong. It grants no permissions or
        approvals.
      </p>
      <button ref={refresh} className="secondary-action" onClick={() => void query.refetch()}>
        Refresh task summary
      </button>
      <p>
        {state.run_status === 'failed' || state.run_status === 'cancelled'
          ? 'Interrupted. No work continues in the background.'
          : 'No work continues in the background.'}
      </p>
      {state.stale && (
        <StateMessage
          compact
          kind="error"
          title="Some source messages changed"
          description="Affected fields are omitted. The next chat turn rebuilds their context."
        />
      )}
      {state.coverage_incomplete && (
        <StateMessage
          compact
          kind="empty"
          title="Summary covers part of this conversation"
          description="The latest messages still take precedence. Chat can read the original history for missing details."
        />
      )}
      {query.isError && (
        <StateMessage
          compact
          kind="error"
          title="Task refresh failed"
          description="Your draft is retained."
        />
      )}
      {state.notes.length === 0 && (
        <StateMessage
          compact
          kind="empty"
          title="No active task summary yet"
          description="A summary is created when older messages leave the model’s recent context."
        />
      )}
      {state.notes.map((note) => (
        <TaskField
          key={`${threadId}:${note.key}`}
          note={note}
          state={state}
          onDismiss={() => refresh.current?.focus()}
        />
      ))}
      {state.effects.length > 0 && (
        <details>
          <summary>Current effect statuses</summary>
          {state.effects.map((effect) => (
            <p key={effect.effect_id}>
              {effect.capability_id} · {effect.status}
            </p>
          ))}
          <p>Pending review is incomplete. Opening this summary does not approve or resume an effect.</p>
        </details>
      )}
    </div>
  )
}

function TaskField({ note, state, onDismiss }: { note: TaskNote; state: TaskState; onDismiss: () => void }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [baseline, setBaseline] = useState({ text: note.text, version: state.version })
  const [draft, setDraft] = useState(note.text)
  const trigger = useRef<HTMLButtonElement>(null)
  const dirty = draft !== baseline.text
  if (!dirty && (baseline.version !== state.version || baseline.text !== note.text)) {
    setBaseline({ text: note.text, version: state.version })
    setDraft(note.text)
  }
  const save = useMutation({
    mutationFn: () =>
      api.correctChatTask({
        thread_id: state.thread_id,
        key: note.key,
        text: draft,
        expected_version: baseline.version,
      }),
    onSuccess: (saved) => {
      const current = saved.notes.find((field) => field.key === note.key)
      setBaseline({ text: current?.text ?? '', version: saved.version })
      setDraft(current?.text ?? '')
      setEditing(false)
      if (current) trigger.current?.focus()
      else onDismiss()
      queryClient.setQueryData(['chat-task', state.thread_id], saved)
    },
  })
  return (
    <section className="chat-task-field">
      <strong>
        {note.kind} · {note.key}
        {note.corrected ? ' · corrected' : ''}
      </strong>
      <p className="instruction-content">{note.text}</p>
      {dirty && <span>Unsaved correction</span>}
      <button ref={trigger} className="secondary-action" onClick={() => setEditing(!editing)}>
        {editing ? `Close correction ${note.key}` : `Correct ${note.key}`}
      </button>
      <div hidden={!editing}>
        <label className="settings-field">
          Correction for {note.key}
          <textarea
            aria-label={`Correction for ${note.key}`}
            rows={3}
            maxLength={600}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <p>Clear the text to dismiss this field. The original source stays available.</p>
        {save.isError && (
          <StateMessage
            compact
            kind="error"
            title={
              save.error instanceof ApiError && save.error.status === 409
                ? 'Task changed elsewhere. Discard and reload before saving.'
                : 'Task correction could not be saved'
            }
          />
        )}
        <button className="primary-button" disabled={save.isPending || !dirty} onClick={() => save.mutate()}>
          Save task correction
        </button>
        <button
          className="secondary-action"
          disabled={save.isPending}
          onClick={() => {
            setBaseline({ text: note.text, version: state.version })
            setDraft(note.text)
            save.reset()
            void queryClient.invalidateQueries({ queryKey: ['chat-task', state.thread_id] })
          }}
        >
          Discard task correction
        </button>
      </div>
      {note.source_item_ids.map((itemId) => (
        <TaskSource key={itemId} threadId={state.thread_id} itemId={itemId} />
      ))}
    </section>
  )
}

function TaskSource({
  threadId,
  itemId,
  initiallyOpen = false,
}: {
  threadId: string
  itemId: string
  initiallyOpen?: boolean
}) {
  const [open, setOpen] = useState(initiallyOpen)
  const [offset, setOffset] = useState(0)
  const source = useQuery({
    queryKey: ['chat-source', threadId, itemId, offset],
    queryFn: () => api.readChatHistory(threadId, itemId, offset),
    enabled: open,
  })
  const entry = source.data?.entries[0]
  return (
    <div>
      <button className="secondary-action" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? `Close source ${itemId}` : `Read source ${itemId}`}
      </button>
      {open && (
        <div>
          {source.isPending && <StateMessage compact kind="loading" title="Loading source message" />}
          {source.isError && <StateMessage compact kind="error" title="Source message could not be loaded" />}
          {entry && (
            <>
              <p className="instruction-content">{entry.text}</p>
              <p>
                Original {entry.role} message · {itemId}
              </p>
              {offset > 0 && (
                <button className="secondary-action" onClick={() => setOffset(Math.max(0, offset - 1200))}>
                  Previous excerpt
                </button>
              )}
              {entry.truncated && (
                <button className="secondary-action" onClick={() => setOffset(offset + entry.text.length)}>
                  Next excerpt
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
