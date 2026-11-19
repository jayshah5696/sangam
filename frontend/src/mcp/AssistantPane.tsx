import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { App } from '@modelcontextprotocol/ext-apps'
import { StateMessage } from '../components/ui/StateMessage'
import {
  assistantResultSchema,
  conversationPageSchema,
  type AssistantResult,
  type AssistantSelection,
  type AssistantSubmitAction,
  type ConversationPage,
  type Workspace,
} from './contracts'
import { AppActionError, callAppTool } from './tool-client'

const statuses = {
  running: 'Assistant is working',
  completed: 'Assistant turn completed',
  needs_review: 'Review required',
  failed: 'Assistant request failed',
  cancelled: 'Assistant request cancelled',
  interrupted: 'Assistant request interrupted',
  result_expired: 'Assistant answer expired',
} as const

export function AssistantPane({
  app,
  workspace,
  active,
  selection,
  dirtyDocument,
  onAccepted,
  onReview,
  onClose,
  onUnsavedChange,
}: {
  app: App
  workspace: Workspace
  active: boolean
  selection: AssistantSelection
  dirtyDocument: boolean
  onAccepted: () => Promise<void>
  onReview: (proposal: AssistantResult['proposals'][number]) => Promise<void>
  onClose: () => void
  onUnsavedChange: (dirty: boolean) => void
}) {
  const [message, setMessage] = useState('')
  const [context, setContext] = useState<'active' | 'selection' | 'tabs'>('active')
  const [attempt, setAttempt] = useState<AssistantSubmitAction | null>(null)
  const [requestKey, setRequestKey] = useState<string | null>(null)
  const [result, setResult] = useState<AssistantResult | null>(null)
  const [history, setHistory] = useState<ConversationPage | null>(null)
  const [newConversation, setNewConversation] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const reading = useRef(false)
  const composer = useRef<HTMLTextAreaElement>(null)
  const running = result?.status === 'running'
  const localDirty = message !== '' || attempt !== null
  useEffect(() => {
    onUnsavedChange(localDirty)
  }, [localDirty, onUnsavedChange])
  useEffect(() => {
    if (active) composer.current?.focus()
  }, [active])

  const readSnapshot = useEffectEvent(async (force: boolean) => {
    const key = requestKey ?? (newConversation ? null : workspace.assistant_request_key)
    if (!active || busy || reading.current || !key) return null
    if (!force && result?.request_key === key && result.status !== 'running') return null
    const observed = generation.current
    reading.current = true
    try {
      const next = assistantResultSchema.parse(
        await callAppTool(app, {
          type: 'assistant_get',
          workspace_id: workspace.workspace_id,
          request_key: key,
          length: 4000,
        }),
      )
      const messages =
        next.run_id === null
          ? null
          : conversationPageSchema.parse(
              await callAppTool(app, {
                type: 'assistant_messages',
                workspace_id: workspace.workspace_id,
                conversation_id: next.conversation_id,
                limit: 10,
                order: 'desc',
              }),
            )
      return {
        result: next,
        messages: messages ? { ...messages, items: [...messages.items].reverse() } : null,
        generation: observed,
      }
    } finally {
      reading.current = false
    }
  })
  useEffect(() => {
    let cancelled = false
    const refresh = (force: boolean) => {
      void readSnapshot(force)
        .then((next) => {
          if (cancelled || !next || next.generation !== generation.current) return
          setResult(next.result)
          if (next.messages) setHistory(next.messages)
          setError('')
        })
        .catch((failure) => {
          if (cancelled) return
          if (
            failure instanceof AppActionError &&
            ['forbidden', 'authentication_required', 'not_found'].includes(failure.code)
          ) {
            setResult(null)
            setHistory(null)
          }
          setError(failure instanceof Error ? failure.message : 'Assistant refresh failed.')
        })
    }
    refresh(true)
    const timer = window.setInterval(() => refresh(false), 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [active, requestKey, workspace.assistant_request_key, workspace.assistant_status, newConversation])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Assistant action failed.')
    } finally {
      setBusy(false)
    }
  }

  async function submit() {
    const action =
      attempt ??
      ({
        type: 'assistant_submit',
        workspace_id: workspace.workspace_id,
        request_key: crypto.randomUUID(),
        message: message.trim(),
        document_id: workspace.document.document_id,
        revision_id:
          context === 'selection' && selection.revision_id
            ? selection.revision_id
            : workspace.document.current_revision_id,
        conversation_id: newConversation ? null : (result?.conversation_id ?? null),
        selection_text: context === 'selection' ? selection.text : '',
        pdf_page_number:
          context === 'selection'
            ? selection.pdf_page_number
            : workspace.location.kind === 'pdf'
              ? workspace.location.page_number
              : null,
        context_documents:
          context === 'tabs'
            ? workspace.layout.tabs
                .filter((tab) => tab.document_id !== workspace.document.document_id)
                .map((tab) => ({ document_id: tab.document_id, revision_id: tab.current_revision_id }))
            : [],
        wait_seconds: 0,
      } satisfies AssistantSubmitAction)
    generation.current += 1
    setAttempt(action)
    try {
      let accepted: AssistantResult
      if (attempt) {
        try {
          accepted = assistantResultSchema.parse(
            await callAppTool(app, {
              type: 'assistant_get',
              workspace_id: workspace.workspace_id,
              request_key: action.request_key,
            }),
          )
        } catch (failure) {
          if (!(failure instanceof AppActionError) || failure.code !== 'not_found') throw failure
          accepted = assistantResultSchema.parse(await callAppTool(app, action))
        }
      } else {
        accepted = assistantResultSchema.parse(await callAppTool(app, action))
      }
      setRequestKey(accepted.request_key)
      setResult(accepted)
      setNewConversation(false)
      setMessage('')
      setAttempt(null)
      onUnsavedChange(false)
      if (accepted.run_id !== null) {
        const messages = conversationPageSchema.parse(
          await callAppTool(app, {
            type: 'assistant_messages',
            workspace_id: workspace.workspace_id,
            conversation_id: accepted.conversation_id,
            order: 'desc',
            limit: 10,
          }),
        )
        setHistory({ ...messages, items: [...messages.items].reverse() })
      }
      await onAccepted()
    } catch (failure) {
      if (failure instanceof AppActionError && failure.outcome === 'rejected') setAttempt(null)
      throw failure
    }
  }

  async function olderMessages() {
    if (!history?.next_cursor) return
    const older = conversationPageSchema.parse(
      await callAppTool(app, {
        type: 'assistant_messages',
        workspace_id: workspace.workspace_id,
        conversation_id: history.conversation_id,
        order: 'desc',
        cursor: history.next_cursor,
        limit: 10,
      }),
    )
    setHistory({ ...older, items: [...older.items].reverse().concat(history.items) })
  }

  async function continueMessage(item: ConversationPage['items'][number]) {
    if (!history || item.next_offset === null) return
    const page = conversationPageSchema.parse(
      await callAppTool(app, {
        type: 'assistant_messages',
        workspace_id: workspace.workspace_id,
        conversation_id: history.conversation_id,
        item_id: item.item_id,
        offset: item.next_offset,
      }),
    )
    const part = page.items[0]
    if (!part || part.offset !== item.next_offset)
      throw new Error('The message passage did not match its continuation.')
    setHistory({
      ...history,
      items: history.items.map((current) =>
        current.item_id === item.item_id
          ? { ...current, text: current.text + part.text, next_offset: part.next_offset }
          : current,
      ),
    })
  }

  const selectionUnavailable =
    dirtyDocument || !selection.text || !selection.revision_id || selection.text.length > 20_000
  const knownKey = requestKey ?? (newConversation ? null : workspace.assistant_request_key)
  const awaitingKnown = knownKey !== null && result?.request_key !== knownKey
  const includedRevision =
    attempt?.revision_id ??
    (context === 'selection' && selection.revision_id
      ? selection.revision_id
      : workspace.document.current_revision_id)
  const includedSources =
    attempt?.context_documents ??
    (context === 'tabs'
      ? workspace.layout.tabs
          .filter((tab) => tab.document_id !== workspace.document.document_id)
          .map((tab) => ({ document_id: tab.document_id, revision_id: tab.current_revision_id }))
      : [])
  const canSend =
    workspace.can_infer &&
    !running &&
    !busy &&
    !awaitingKnown &&
    message.trim() !== '' &&
    (context !== 'selection' || !selectionUnavailable)

  return (
    <section className="mcp-assistant" aria-label="Sangam assistant" hidden={!active}>
      <header className="mcp-review-toolbar">
        <h2>Sangam assistant</h2>
        <div className="mcp-controls">
          <button
            className="secondary-action"
            disabled={busy || running || awaitingKnown || localDirty}
            onClick={() => {
              generation.current += 1
              setNewConversation(true)
              setRequestKey(null)
              setResult(null)
              setHistory(null)
              setError('')
            }}
          >
            New conversation
          </button>
          <button className="secondary-action" disabled={busy || localDirty} onClick={onClose}>
            Close assistant
          </button>
        </div>
      </header>
      <div className="mcp-action-content">
        {error && <StateMessage compact kind="error" title="Assistant action failed" description={error} />}
        {workspace.assistant_unavailable && (
          <StateMessage
            compact
            kind="error"
            title="Previous assistant context is unavailable"
            description="Current permissions do not cover every source in that conversation."
          />
        )}
        {attempt && (
          <StateMessage
            compact
            kind={busy ? 'loading' : 'error'}
            title={busy ? 'Submitting request' : 'Submission not confirmed'}
          />
        )}
        {result && !attempt && (
          <div
            className="mcp-turn-status"
            data-status={result.status}
            role={
              running || result.status === 'completed' || result.status === 'needs_review'
                ? 'status'
                : 'alert'
            }
          >
            <span className="mcp-turn-dot" aria-hidden="true" />
            <div className="mcp-turn-copy">
              <strong>{statuses[result.status]}</strong>
              {result.error && <p>{result.error}</p>}
            </div>
            {running && (
              <button
                className="secondary-action"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (!result) return
                    const cancelled = assistantResultSchema.parse(
                      await callAppTool(app, {
                        type: 'assistant_cancel',
                        workspace_id: workspace.workspace_id,
                        request_key: result.request_key,
                      }),
                    )
                    setResult(cancelled)
                    await onAccepted()
                  })
                }
              >
                Cancel request
              </button>
            )}
          </div>
        )}
        {history && (
          <div className="mcp-assistant-messages" aria-label="Conversation messages">
            {history.next_cursor && (
              <button className="secondary-action" disabled={busy} onClick={() => void run(olderMessages)}>
                Older messages
              </button>
            )}
            {history.items.map((item) => (
              <article
                className="mcp-assistant-message"
                key={item.item_id}
                aria-label={item.role === 'user' ? 'Your message' : 'Sangam response'}
              >
                <strong>{item.role === 'user' ? 'You' : 'Sangam'}</strong>
                <div className="mcp-message-text">{item.text}</div>
                {item.next_offset !== null && (
                  <button
                    className="secondary-action"
                    disabled={busy}
                    onClick={() => void run(() => continueMessage(item))}
                  >
                    Read more of this message
                  </button>
                )}
              </article>
            ))}
          </div>
        )}
        {result?.proposals.map((proposal) => (
          <div className="mcp-assistant-artifact" key={proposal.proposal_id}>
            <span className="scope-badge">{proposal.status}</span>
            <button
              className="secondary-action"
              disabled={busy || localDirty}
              onClick={() => void run(() => onReview(proposal))}
            >
              Review {proposal.summary ?? `proposal ${proposal.proposal_id}`}
            </button>
          </div>
        ))}
        {result?.effects.map((effect) => (
          <div className="mcp-assistant-artifact" key={effect.effect_id}>
            <span>{effect.capability_id}</span>
            <span className="scope-badge">{effect.status}</span>
            <span className="mcp-review-reference">
              {effect.revision_id ?? effect.resource_id ?? effect.effect_id}
            </span>
          </div>
        ))}
        {result?.artifacts_truncated && (
          <StateMessage compact kind="empty" title="More artifacts are available in Sangam" />
        )}
        <div className="mcp-assistant-composer" role="form" aria-label="Ask Sangam">
          <label className="mcp-review-field">
            Assistant context
            <select
              aria-label="Assistant context"
              value={context}
              disabled={busy || attempt !== null}
              onChange={(event) => {
                const value = event.target.value
                if (value === 'active' || value === 'selection' || value === 'tabs') setContext(value)
              }}
            >
              <option value="active">Saved active document</option>
              <option value="selection" disabled={selectionUnavailable}>
                Selected saved passage
              </option>
              <option value="tabs">Saved revisions of open tabs</option>
            </select>
          </label>
          <div className="mcp-assistant-context" role="region" aria-label="Included context">
            <span>{workspace.document.title}</span>
            <span className="mcp-review-reference">{includedRevision}</span>
            {includedSources.map((source) => (
              <div key={source.document_id}>
                {workspace.layout.tabs.find((tab) => tab.document_id === source.document_id)?.title ??
                  source.document_id}
                <span className="mcp-review-reference"> {source.revision_id}</span>
              </div>
            ))}
            {context === 'selection' && <blockquote>{attempt?.selection_text ?? selection.text}</blockquote>}
            {attempt?.pdf_page_number ? (
              <span>Page {attempt.pdf_page_number}</span>
            ) : (
              workspace.location.kind === 'pdf' && <span>Page {workspace.location.page_number}</span>
            )}
          </div>
          {dirtyDocument && <p>Unsaved document edits are not included.</p>}
          {!workspace.can_infer && (
            <StateMessage
              compact
              kind="empty"
              title="Sending requires inference permission"
              description="Existing results remain readable with their source permissions."
            />
          )}
          <label className="mcp-review-field">
            Message to Sangam
            <textarea
              aria-label="Message to Sangam"
              ref={composer}
              value={message}
              maxLength={16000}
              disabled={busy || attempt !== null}
              onChange={(event) => setMessage(event.target.value)}
            />
          </label>
          <div className="mcp-controls">
            {attempt ? (
              <button className="primary-button" disabled={busy} onClick={() => void run(submit)}>
                Retry submission
              </button>
            ) : (
              <button className="primary-button" disabled={!canSend} onClick={() => void run(submit)}>
                Send message
              </button>
            )}
            {message && !attempt && (
              <button className="secondary-action" disabled={busy} onClick={() => setMessage('')}>
                Discard message
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
