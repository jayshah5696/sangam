import { useEffect, useRef, useState } from 'react'
import type { App } from '@modelcontextprotocol/ext-apps'
import { StateMessage } from '../components/ui/StateMessage'
import { creationResultSchema, type CreationAction, type CreationResult, type Workspace } from './contracts'
import { AppActionError, callAppTool } from './tool-client'

export function NewDocument({
  app,
  workspace,
  onCreated,
  onClose,
  onUnsavedChange,
}: {
  app: App
  workspace: Workspace
  onCreated: (result: CreationResult) => Promise<void>
  onClose: () => void
  onUnsavedChange: (dirty: boolean) => void
}) {
  const [title, setTitle] = useState('')
  const [path, setPath] = useState(workspace.create_prefixes?.[0] ?? '')
  const [content, setContent] = useState('')
  const [attempt, setAttempt] = useState<CreationAction | null>(null)
  const [created, setCreated] = useState<CreationResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const titleInput = useRef<HTMLInputElement>(null)
  const dirty =
    created === null &&
    (attempt !== null || title !== '' || content !== '' || path !== (workspace.create_prefixes?.[0] ?? ''))
  useEffect(() => {
    onUnsavedChange(dirty)
  }, [dirty, onUnsavedChange])
  useEffect(() => {
    titleInput.current?.focus()
  }, [])

  async function create() {
    setBusy(true)
    setError('')
    const action =
      attempt ??
      ({
        type: 'document_create',
        workspace_id: workspace.workspace_id,
        title: title.trim(),
        content,
        path: path.trim() || null,
        operation_key: crypto.randomUUID(),
      } satisfies CreationAction)
    setAttempt(action)
    try {
      const result = creationResultSchema.parse(await callAppTool(app, action))
      setCreated(result)
      setAttempt(null)
      onUnsavedChange(false)
      await onCreated(result)
    } catch (failure) {
      if (failure instanceof AppActionError && failure.outcome === 'rejected') setAttempt(null)
      setError(failure instanceof Error ? failure.message : 'Document creation failed.')
    } finally {
      setBusy(false)
    }
  }

  async function open() {
    if (!created) return
    setBusy(true)
    setError('')
    try {
      await onCreated(created)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The document could not be opened.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mcp-new-document" aria-label="Create document">
      <header className="mcp-review-toolbar">
        <h2>New document</h2>
        <button
          className="secondary-action"
          disabled={busy || attempt !== null}
          onClick={() => {
            onUnsavedChange(false)
            onClose()
          }}
        >
          {created || !dirty ? 'Close creation' : 'Discard creation'}
        </button>
      </header>
      <div className="mcp-action-content">
        {error && (
          <StateMessage
            compact
            kind="error"
            title={created ? 'Document created, but could not open it' : 'Document creation failed'}
            description={error}
          />
        )}
        {created ? (
          <>
            <StateMessage
              compact
              kind="success"
              title="Document created"
              description={`Saved revision ${created.created_revision_id}`}
            />
            <button className="primary-button" disabled={busy} onClick={() => void open()}>
              Open document
            </button>
          </>
        ) : (
          <div role="form" aria-label="New document">
            <label className="mcp-review-field">
              Document title
              <input
                ref={titleInput}
                value={title}
                maxLength={500}
                disabled={busy || attempt !== null}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="mcp-review-field">
              Document path
              <input
                value={path}
                maxLength={1000}
                disabled={busy || attempt !== null}
                onChange={(event) => setPath(event.target.value)}
                placeholder="notes/document.md"
              />
            </label>
            <label className="mcp-review-field">
              Initial content
              <textarea
                aria-label="Initial content"
                value={content}
                disabled={busy || attempt !== null}
                onChange={(event) => setContent(event.target.value)}
              />
            </label>
            <button className="primary-button" disabled={busy || !title.trim()} onClick={() => void create()}>
              {attempt ? 'Retry creation' : 'Create document'}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
