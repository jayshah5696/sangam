import { App } from '@modelcontextprotocol/ext-apps'
import { createRoot } from 'react-dom/client'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { MarkdownEditor } from '../components/MarkdownEditor'
import { StateMessage } from '../components/ui/StateMessage'
import { errorSchema, workspaceSchema, type AppAction, type Workspace } from './contracts'
import '../styles.css'
import '../styles/mcp-workspace.css'

const app = new App({ name: 'Sangam document workspace', version: '0.1.0' }, {})
type SaveAttempt = { request: Extract<AppAction, { type: 'save' }>; content: string }

function DocumentApp() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [sharedConflict, setSharedConflict] = useState(false)
  const checkpointBlocked = useRef(false)
  const current = useRef<Workspace | null>(null)
  const content = useRef('')
  const queue = useRef(Promise.resolve())
  const saveAttempt = useRef<SaveAttempt | null>(null)

  function apply(next: Workspace, replaceText: boolean) {
    if (current.current?.workspace_id === next.workspace_id && current.current.version > next.version) return
    current.current = next
    setWorkspace(next)
    if (replaceText) {
      content.current = next.draft ?? next.document.content
      setText(content.current)
    }
  }

  async function action(request: AppAction, replaceText = false) {
    const contentBeforeRead = content.current
    const previous = current.current
    const reply = await app.callServerTool({ name: 'mcp_app', arguments: { action: request } })
    if (reply.isError) {
      const parsed = errorSchema.safeParse(reply.structuredContent)
      if (request.type === 'checkpoint' && parsed.success && parsed.data.error.code === 'revision_conflict') {
        checkpointBlocked.current = true
        setSharedConflict(true)
      }
      throw new Error(
        parsed.success ? parsed.data.error.message : 'The operation failed. Your local edits are preserved.',
      )
    }
    const next = workspaceSchema.parse(reply.structuredContent)
    if (
      request.type === 'refresh' &&
      previous &&
      next.version !== previous.version &&
      next.draft !== previous.draft &&
      content.current !== previous.document.content
    ) {
      checkpointBlocked.current = true
      setSharedConflict(true)
    }
    apply(next, replaceText && content.current === contentBeforeRead)
    return next
  }

  async function checkpoint() {
    const state = current.current
    if (!state || !state.can_update || content.current === (state.draft ?? state.document.content)) return
    if (checkpointBlocked.current)
      throw new Error(
        'This workspace changed in another view. Your local edits are preserved. Resolve the shared draft before backing up or saving.',
      )
    await action({
      type: 'checkpoint',
      workspace_id: state.workspace_id,
      expected_version: state.version,
      content: content.current,
    })
  }

  function enqueue(operation: () => Promise<void>, clearError = true) {
    queue.current = queue.current.then(async () => {
      setBusy(true)
      try {
        await operation()
        if (clearError) setError('')
      } catch (failure) {
        setError(
          failure instanceof Error
            ? failure.message
            : 'The operation failed. Your local edits are preserved.',
        )
      } finally {
        setBusy(false)
      }
    })
    return queue.current
  }

  const backupAfterEdit = useEffectEvent(() => {
    void enqueue(checkpoint)
  })
  const refreshVisibleWorkspace = useEffectEvent(() => {
    if (document.visibilityState !== 'visible') return
    void enqueue(async () => {
      const state = current.current
      if (!state) return
      const clean = state.draft === null && content.current === state.document.content
      await action({ type: 'refresh', workspace_id: state.workspace_id }, clean)
    }, false)
  })

  const prepareTeardown = useEffectEvent(async () => {
    await queue.current
    await checkpoint()
    return {}
  })

  useEffect(() => {
    app.onteardown = prepareTeardown
    app.addEventListener('toolresult', (event) => {
      if (event.isError) {
        setError('The workspace could not be opened with this connection.')
        return
      }
      const next = workspaceSchema.parse(event.structuredContent)
      if (
        current.current &&
        content.current !== (current.current.draft ?? current.current.document.content)
      ) {
        setError('Local edits are waiting for backup. Finish or discard them before navigating.')
        return
      }
      apply(next, true)
    })
    void app
      .connect()
      .catch((failure) =>
        setError(failure instanceof Error ? failure.message : 'The MCP host could not connect.'),
      )
    return () => {
      void app.close()
    }
  }, [])

  useEffect(() => {
    if (!workspace || text === (workspace.draft ?? workspace.document.content)) return
    const timeout = window.setTimeout(() => backupAfterEdit(), 400)
    return () => window.clearTimeout(timeout)
  }, [text, workspace])

  useEffect(() => {
    const timer = window.setInterval(() => {
      refreshVisibleWorkspace()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [])

  async function save() {
    if (!saveAttempt.current) {
      await checkpoint()
      const state = current.current
      if (!state || state.draft === null) return
      saveAttempt.current = {
        request: {
          type: 'save',
          workspace_id: state.workspace_id,
          expected_version: state.version,
          operation_key: crypto.randomUUID(),
        },
        content: state.draft,
      }
    }
    const attempt = saveAttempt.current
    const next = await action(attempt.request)
    saveAttempt.current = null
    if (content.current === attempt.content) apply(next, true)
    else await checkpoint()
  }

  if (!workspace)
    return (
      <main className="mcp-app">
        <StateMessage kind={error ? 'error' : 'loading'} title={error || 'Opening document workspace'} />
      </main>
    )
  const backedUp = text === (workspace.draft ?? workspace.document.content)
  const dirty = workspace.draft !== null || !backedUp

  return (
    <main className="mcp-app">
      <header className="mcp-document-header">
        <div className="mcp-document-identity">
          <p className="eyebrow">Sangam · Document workspace</p>
          <h1>{workspace.document.title}</h1>
          <p className="mcp-path">{workspace.document.path ?? 'Saved draft'}</p>
        </div>
        <div className="mcp-controls">
          <button
            className="secondary-action"
            disabled={busy}
            onClick={() => {
              void enqueue(async () => {
                await checkpoint()
                const state = current.current
                if (state)
                  await action({ type: 'refresh', workspace_id: state.workspace_id }, state.draft === null)
              })
            }}
          >
            Refresh
          </button>
          <button
            className="primary-button"
            disabled={busy || !dirty || !workspace.can_update}
            onClick={() => {
              void enqueue(save)
            }}
          >
            Save
          </button>
        </div>
      </header>
      <div className="mcp-status" role="status">
        {!workspace.can_update
          ? 'Read-only connection'
          : !backedUp
            ? 'Backup pending'
            : dirty
              ? 'Draft backed up'
              : 'All changes saved'}
      </div>
      {error && (
        <StateMessage
          compact
          kind="error"
          title="Action needs attention"
          description={error}
          action={
            <button
              className="secondary-action"
              onClick={() => {
                void enqueue(saveAttempt.current ? save : checkpoint)
              }}
            >
              Retry action
            </button>
          }
        />
      )}
      {workspace.conflict && (
        <section className="mcp-conflict">
          <strong>Saved document changed</strong>
          <p>Your draft is preserved. Compare it with the current saved revision before continuing.</p>
          <details>
            <summary>Compare with saved document</summary>
            <pre>{workspace.document.content}</pre>
          </details>
        </section>
      )}
      {sharedConflict && (
        <StateMessage
          compact
          kind="error"
          title="Shared draft changed"
          description="Your local edits are preserved. Copy them if needed, then resolve the shared draft to load the other view's checkpoint."
        />
      )}
      <section className="mcp-editor" aria-label="Document editor">
        {workspace.can_update ? (
          <MarkdownEditor
            value={text}
            onChange={(value) => {
              content.current = value
              setText(value)
            }}
          />
        ) : (
          <pre>{workspace.document.content}</pre>
        )}
      </section>
      <footer className="mcp-document-footer">
        <span>Save commits a revision. Draft backup does not.</span>
        {dirty && !discarding && (
          <button className="secondary-action" onClick={() => setDiscarding(true)}>
            {sharedConflict ? 'Resolve shared draft' : 'Discard draft'}
          </button>
        )}
        {discarding && (
          <div className="mcp-controls">
            <span>
              {sharedConflict
                ? 'Replace local edits with the shared checkpoint?'
                : 'Discard these unsaved edits?'}
            </span>
            <button className="secondary-action" onClick={() => setDiscarding(false)}>
              Keep editing
            </button>
            <button
              className="secondary-action"
              onClick={() => {
                void enqueue(async () => {
                  const state = current.current
                  if (state) {
                    if (checkpointBlocked.current)
                      await action({ type: 'refresh', workspace_id: state.workspace_id }, true)
                    else
                      await action(
                        {
                          type: 'discard',
                          workspace_id: state.workspace_id,
                          expected_version: state.version,
                        },
                        true,
                      )
                  }
                  checkpointBlocked.current = false
                  setSharedConflict(false)
                  saveAttempt.current = null
                  setDiscarding(false)
                })
              }}
            >
              Discard and reload
            </button>
          </div>
        )}
      </footer>
    </main>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('MCP App root is missing')
createRoot(root).render(<DocumentApp />)
