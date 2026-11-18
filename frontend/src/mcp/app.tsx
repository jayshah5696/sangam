import { App } from '@modelcontextprotocol/ext-apps'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { MarkdownEditor } from '../components/MarkdownEditor'
import { StateMessage } from '../components/ui/StateMessage'
import { PdfPane } from './PdfPane'
import { ProposalReview } from './ProposalReview'
import { NewDocument } from './NewDocument'
import { AssistantPane } from './AssistantPane'
import { applyHostAppearance } from './appearance'
import {
  errorSchema,
  hitsSchema,
  workspaceSchema,
  type AppAction,
  type SearchResults,
  type Workspace,
  type ViewLocation,
  type ProposalAction,
  type CreationAction,
  type AssistantAction,
  type AssistantSelection,
  type AssistantResult,
} from './contracts'
import '../styles.css'
import '../styles/mcp-workspace.css'

const app = new App({ name: 'Sangam document workspace', version: '0.1.0' }, {})
type SaveAttempt = { request: Extract<AppAction, { type: 'save' }>; content: string }
type WorkspaceAction = Exclude<
  AppAction,
  | ProposalAction
  | CreationAction
  | AssistantAction
  | { type: 'search' | 'pdf_bytes' | 'pdf_page' | 'pdf_search' | 'pdf_annotations' | 'pdf_note' }
>
type NavigationAction = Extract<AppAction, { type: 'open' | 'activate' | 'close' | 'compare' }>

function DocumentApp() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [sharedConflict, setSharedConflict] = useState(false)
  const [navigating, setNavigating] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewProposalId, setReviewProposalId] = useState<string | null>(null)
  const [creationOpen, setCreationOpen] = useState(false)
  const [creationGeneration, setCreationGeneration] = useState(0)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantSelection, setAssistantSelection] = useState<AssistantSelection>({
    text: '',
    pdf_page_number: null,
  })
  const [locationChanged, setLocationChanged] = useState(0)
  const [query, setQuery] = useState('')
  const [searchedQuery, setSearchedQuery] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null)
  const [searchError, setSearchError] = useState('')
  const checkpointBlocked = useRef(false)
  const current = useRef<Workspace | null>(null)
  const content = useRef('')
  const location = useRef<ViewLocation | null>(null)
  const queue = useRef(Promise.resolve())
  const saveAttempt = useRef<SaveAttempt | null>(null)
  const unsavedPdfNote = useRef(false)
  const unsavedReview = useRef(false)
  const unsavedCreation = useRef(false)
  const unsavedMessage = useRef(false)
  const pdfSelection = useRef<AssistantSelection>({ text: '', pdf_page_number: null })
  const reviewTrigger = useRef<HTMLButtonElement>(null)
  const creationTrigger = useRef<HTMLButtonElement>(null)
  const assistantTrigger = useRef<HTMLButtonElement>(null)
  const retryAction = useRef<(() => Promise<void>) | null>(null)
  const tabButtons = useRef(new Map<string, HTMLButtonElement>())
  const pendingTabFocus = useRef<string | null>(null)

  useLayoutEffect(() => {
    const target = pendingTabFocus.current
    if (target) tabButtons.current.get(target)?.focus()
    pendingTabFocus.current = null
  }, [workspace?.workspace_id])

  function apply(next: Workspace, replaceText: boolean) {
    if (current.current?.workspace_id === next.workspace_id && current.current.version > next.version) return
    if (current.current?.workspace_id === next.workspace_id) {
      if (current.current.view_version > next.view_version) {
        next.view_version = current.current.view_version
        next.location = current.current.location
      }
      if (current.current.layout.version > next.layout.version) {
        next.layout = current.current.layout
        next.comparison = current.current.comparison
      }
    }
    if (current.current?.workspace_id !== next.workspace_id) location.current = next.location
    current.current = next
    setWorkspace(next)
    if (replaceText) {
      content.current = next.draft ?? next.document.content
      setText(content.current)
    }
  }

  async function requestWorkspace(request: WorkspaceAction) {
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
    return workspaceSchema.parse(reply.structuredContent)
  }

  async function action(request: WorkspaceAction, replaceText = false) {
    const contentBeforeRead = content.current
    const previous = current.current
    const next = await requestWorkspace(request)
    if (request.type === 'refresh') applyRefresh(next, previous, contentBeforeRead, replaceText)
    else apply(next, replaceText && content.current === contentBeforeRead)
    return next
  }

  function applyRefresh(
    next: Workspace,
    previous: Workspace | null,
    contentBeforeRead: string,
    replaceText: boolean,
  ) {
    if (previous && next.version < previous.version) return
    if (
      previous &&
      next.version !== previous.version &&
      next.draft !== previous.draft &&
      content.current !== previous.document.content
    ) {
      checkpointBlocked.current = true
      setSharedConflict(true)
    }
    apply(next, replaceText && content.current === contentBeforeRead)
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

  async function checkpointView() {
    const state = current.current
    const value = location.current
    if (!state || !value || JSON.stringify(value) === JSON.stringify(state.location)) return
    await action({
      type: 'view',
      workspace_id: state.workspace_id,
      expected_view_version: state.view_version,
      location: value,
    })
  }

  const backupView = useEffectEvent(() => {
    if (!navigating) void enqueue(checkpointView, false)
  })
  useEffect(() => {
    if (!locationChanged) return
    const timer = window.setTimeout(() => backupView(), 600)
    return () => window.clearTimeout(timer)
  }, [locationChanged])

  function enqueue(operation: () => Promise<void>, foreground = true) {
    queue.current = queue.current.then(async () => {
      if (foreground) setBusy(true)
      try {
        await operation()
        if (foreground) {
          setError('')
          retryAction.current = null
        }
      } catch (failure) {
        retryAction.current = operation
        setError(
          failure instanceof Error
            ? failure.message
            : 'The operation failed. Your local edits are preserved.',
        )
      } finally {
        if (foreground) setBusy(false)
      }
    })
    return queue.current
  }

  const backupAfterEdit = useEffectEvent(() => {
    if (navigating) return
    void enqueue(checkpoint)
  })
  const refreshVisibleWorkspace = useEffectEvent(() => {
    if (document.visibilityState !== 'visible' || navigating) return
    void enqueue(async () => {
      const state = current.current
      if (!state) return
      const clean = state.draft === null && content.current === state.document.content
      await action({ type: 'refresh', workspace_id: state.workspace_id }, clean)
    }, false)
  })

  const prepareTeardown = useEffectEvent(async () => {
    if (unsavedCreation.current)
      throw new Error('Finish or discard the new document before reopening the App.')
    if (unsavedMessage.current)
      throw new Error('Send, retry, or discard your assistant message before reopening the App.')
    if (unsavedReview.current)
      throw new Error('Finish or discard your proposal review edits before reopening the App.')
    if (unsavedPdfNote.current) throw new Error('Save or discard the page note before reopening the App.')
    // The host can remove this frame after the acknowledgement. Apply the
    // editing guard synchronously before taking the final checkpoint.
    flushSync(() => setNavigating(true))
    try {
      await queue.current
      await checkpoint()
      await checkpointView()
      return {}
    } catch (failure) {
      setNavigating(false)
      throw failure
    }
  })

  useEffect(() => {
    app.onhostcontextchanged = () => applyHostAppearance(app.getHostContext())
    app.onteardown = prepareTeardown
    app.addEventListener('toolresult', (event) => {
      if (event.isError) {
        setError('The workspace could not be opened with this connection.')
        return
      }
      const next = workspaceSchema.parse(event.structuredContent)
      if (current.current?.workspace_id === next.workspace_id) {
        const clean = current.current.draft === null && content.current === current.current.document.content
        applyRefresh(next, current.current, content.current, clean)
        return
      }
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
      .then(() => applyHostAppearance(app.getHostContext()))
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

  async function navigate(makeRequest: (state: Workspace) => NavigationAction) {
    if (unsavedCreation.current)
      throw new Error('Finish or discard the new document before changing documents.')
    if (unsavedMessage.current)
      throw new Error('Send, retry, or discard your assistant message before changing documents.')
    if (unsavedReview.current)
      throw new Error('Finish or discard your proposal review edits before changing documents.')
    if (unsavedPdfNote.current) throw new Error('Save or discard the page note before changing documents.')
    if (saveAttempt.current)
      throw new Error(
        'Resolve the pending Save before switching or closing documents. Retry the Save or explicitly discard the draft.',
      )
    flushSync(() => setNavigating(true))
    try {
      await checkpoint()
      await checkpointView()
      const state = current.current
      if (!state) return
      const next = await requestWorkspace(makeRequest(state))
      // A keystroke queued before the editor became read-only still belongs to
      // the outgoing document. Acknowledge it before replacing the active view.
      while (content.current !== (current.current?.draft ?? current.current?.document.content))
        await checkpoint()
      const latest = current.current
      if (latest?.layout.layout_id === next.layout.layout_id && latest.layout.version >= next.layout.version)
        next.layout = latest.layout
      checkpointBlocked.current = false
      setSharedConflict(false)
      setDiscarding(false)
      setSearchOpen(false)
      setReviewOpen(false)
      setCreationOpen(false)
      setAssistantOpen(false)
      pdfSelection.current = { text: '', pdf_page_number: null }
      pendingTabFocus.current = next.workspace_id
      apply(next, true)
      tabButtons.current.get(next.workspace_id)?.focus()
    } finally {
      setNavigating(false)
    }
  }

  async function searchDocuments(searchQuery: string, offset = 0) {
    setSearchError('')
    try {
      const reply = await app.callServerTool({
        name: 'mcp_app',
        arguments: {
          action: { type: 'search', query: searchQuery, limit: 10, offset },
        },
      })
      if (reply.isError) {
        const parsed = errorSchema.safeParse(reply.structuredContent)
        throw new Error(parsed.success ? parsed.data.error.message : 'Document search failed.')
      }
      const next = hitsSchema.parse(reply.structuredContent)
      setSearchedQuery(searchQuery)
      setSearchResults((previous) => ({
        items: offset === 0 ? next.items : [...(previous?.items ?? []), ...next.items],
        next_offset: next.next_offset,
      }))
    } catch (failure) {
      setSearchError(failure instanceof Error ? failure.message : 'Document search failed.')
    }
  }

  function activate(workspaceId: string) {
    return enqueue(() =>
      navigate((state) => ({
        type: 'activate',
        workspace_id: state.workspace_id,
        target_workspace_id: workspaceId,
        expected_layout_version: state.layout.version,
      })),
    )
  }

  function requireResolvedPanel() {
    if (unsavedReview.current) throw new Error('Finish or discard the proposal review edits first.')
    if (unsavedCreation.current) throw new Error('Finish or discard the new document first.')
    if (unsavedMessage.current) throw new Error('Send, retry, or discard your assistant message first.')
    if (unsavedPdfNote.current) throw new Error('Save or discard the page note first.')
  }

  async function openAssistantProposal(proposal: AssistantResult['proposals'][number]) {
    const state = current.current
    if (!state) return
    if (state.document.document_id !== proposal.document_id) {
      await enqueue(() =>
        navigate((latest) => ({
          type: 'open',
          workspace_id: latest.workspace_id,
          expected_layout_version: latest.layout.version,
          document_id: proposal.document_id,
        })),
      )
    }
    setAssistantOpen(false)
    setReviewProposalId(proposal.proposal_id)
    setReviewOpen(true)
  }

  if (!workspace)
    return (
      <main className="mcp-app">
        <StateMessage kind={error ? 'error' : 'loading'} title={error || 'Opening document workspace'} />
      </main>
    )
  const backedUp = text === (workspace.draft ?? workspace.document.content)
  const dirty = workspace.draft !== null || !backedUp
  const controlsDisabled = busy || navigating

  return (
    <main className="mcp-app">
      <details
        className="mcp-workspace-search"
        open={searchOpen}
        onToggle={(event) => setSearchOpen(event.currentTarget.open)}
      >
        <summary>Find documents</summary>
        <div className="mcp-search" role="search" aria-label="Search Sangam documents">
          <label>
            Search documents in Sangam
            <input
              disabled={navigating}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && query.trim() && !controlsDisabled) {
                  event.preventDefault()
                  void enqueue(() => searchDocuments(query), false)
                }
              }}
            />
          </label>
          <button
            className="primary-button"
            disabled={controlsDisabled || !query.trim()}
            type="button"
            onClick={() => {
              void enqueue(() => searchDocuments(query), false)
            }}
          >
            Search workspace
          </button>
        </div>
        {searchError && <StateMessage compact kind="error" title="Search failed" description={searchError} />}
        {searchResults && (
          <section aria-label="Workspace search results">
            <p className="mcp-search-description">Results for {searchedQuery}</p>
            {searchResults.items.length === 0 ? (
              <StateMessage compact kind="empty" title="No documents found" />
            ) : (
              <ul className="mcp-results">
                {searchResults.items.map((hit) => (
                  <li key={hit.document_id}>
                    <button
                      className="secondary-action"
                      aria-label={`Open ${hit.title}`}
                      disabled={controlsDisabled}
                      onClick={() => {
                        void enqueue(() =>
                          navigate((state) => ({
                            type: 'open',
                            workspace_id: state.workspace_id,
                            document_id: hit.document_id,
                            expected_layout_version: state.layout.version,
                          })),
                        )
                      }}
                    >
                      {hit.title}
                      <span>{hit.path}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {searchResults.next_offset !== null && (
              <button
                className="secondary-action"
                disabled={controlsDisabled}
                onClick={() => {
                  const offset = searchResults.next_offset
                  if (offset !== null && searchedQuery !== null)
                    void enqueue(() => searchDocuments(searchedQuery, offset), false)
                }}
              >
                More results
              </button>
            )}
          </section>
        )}
      </details>
      <div className="mcp-tabs" role="tablist" aria-label="Open documents">
        {workspace.layout.tabs.map((tab, index) => (
          <div className="mcp-tab editor-tab" key={tab.workspace_id}>
            <button
              role="tab"
              className="mcp-tab-button"
              id={`tab-${tab.workspace_id}`}
              aria-controls="mcp-document-panel"
              aria-label={tab.title}
              aria-selected={tab.workspace_id === workspace.workspace_id}
              tabIndex={tab.workspace_id === workspace.workspace_id ? 0 : -1}
              disabled={navigating}
              ref={(button) => {
                if (button) tabButtons.current.set(tab.workspace_id, button)
                else tabButtons.current.delete(tab.workspace_id)
              }}
              onClick={() => {
                void activate(tab.workspace_id)
              }}
              onKeyDown={(event) => {
                const tabs = workspace.layout.tabs
                let target: number
                if (event.key === 'ArrowRight') target = (index + 1) % tabs.length
                else if (event.key === 'ArrowLeft') target = (index - 1 + tabs.length) % tabs.length
                else if (event.key === 'Home') target = 0
                else if (event.key === 'End') target = tabs.length - 1
                else return
                event.preventDefault()
                const next = tabs[target]
                if (next) void activate(next.workspace_id)
              }}
            >
              <span>{tab.title}</span>
              {(tab.has_draft || (tab.workspace_id === workspace.workspace_id && dirty)) && (
                <span className="mcp-draft-mark" aria-hidden="true">
                  •
                </span>
              )}
            </button>
            <button
              className="mcp-tab-close"
              aria-label={`Compare ${tab.title}`}
              title="Open this document for comparison"
              disabled={controlsDisabled || tab.workspace_id === workspace.workspace_id}
              onClick={() => {
                void enqueue(() =>
                  navigate((state) => ({
                    type: 'compare',
                    workspace_id: state.workspace_id,
                    target_workspace_id: tab.workspace_id,
                    expected_layout_version: state.layout.version,
                  })),
                )
              }}
            >
              ⇄
            </button>
            <button
              className="mcp-tab-close"
              aria-label={`Close ${tab.title}`}
              title="Save or discard drafts before closing documents"
              disabled={
                controlsDisabled ||
                workspace.layout.tabs.length === 1 ||
                tab.has_draft ||
                (tab.workspace_id === workspace.workspace_id && dirty)
              }
              onClick={() => {
                void enqueue(() =>
                  navigate((state) => ({
                    type: 'close',
                    workspace_id: state.workspace_id,
                    target_workspace_id: tab.workspace_id,
                    expected_layout_version: state.layout.version,
                  })),
                )
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {workspace.layout.unavailable_count > 0 && (
        <StateMessage
          compact
          kind="error"
          title="Some open documents are unavailable"
          description="This connection cannot currently read every document. Their drafts remain stored."
        />
      )}
      <div
        className="mcp-document-panel"
        id="mcp-document-panel"
        role="tabpanel"
        aria-labelledby={`tab-${workspace.workspace_id}`}
      >
        <header
          className={`mcp-document-header${workspace.document.content_type === 'application/pdf' ? ' mcp-pdf-header' : ''}`}
        >
          <div className="mcp-document-identity">
            <h1 title={workspace.document.title}>{workspace.document.title}</h1>
            <p className="mcp-path" title={workspace.document.path ?? 'Saved draft'}>
              {workspace.document.path ?? 'Saved draft'}
            </p>
          </div>
          <div className="mcp-controls">
            <button
              className="secondary-action"
              ref={creationTrigger}
              disabled={controlsDisabled || workspace.create_prefixes?.length === 0}
              onClick={() => {
                void enqueue(async () => {
                  requireResolvedPanel()
                  await checkpoint()
                  await checkpointView()
                  setReviewOpen(false)
                  setAssistantOpen(false)
                  setCreationGeneration((value) => value + 1)
                  setCreationOpen(true)
                })
              }}
            >
              New document
            </button>
            <button
              className="secondary-action"
              ref={assistantTrigger}
              disabled={controlsDisabled}
              onClick={() => {
                const state = current.current
                const position = location.current
                if (!state) return
                const selected =
                  state.location.kind === 'pdf'
                    ? pdfSelection.current
                    : {
                        text:
                          position?.kind === 'text' && content.current === state.document.content
                            ? content.current.slice(
                                Math.min(position.anchor, position.head),
                                Math.max(position.anchor, position.head),
                              )
                            : '',
                        pdf_page_number: null,
                      }
                void enqueue(async () => {
                  requireResolvedPanel()
                  await checkpoint()
                  await checkpointView()
                  setAssistantSelection({ ...selected, revision_id: state.document.current_revision_id })
                  setReviewOpen(false)
                  setCreationOpen(false)
                  setAssistantOpen(true)
                })
              }}
            >
              Ask Sangam
            </button>
            {workspace.document.content_type === 'text/markdown' && (
              <button
                className="secondary-action"
                ref={reviewTrigger}
                aria-expanded={reviewOpen}
                disabled={controlsDisabled}
                onClick={() => {
                  void enqueue(async () => {
                    requireResolvedPanel()
                    await checkpoint()
                    await checkpointView()
                    setAssistantOpen(false)
                    setCreationOpen(false)
                    setReviewProposalId(null)
                    setReviewOpen(true)
                  })
                }}
              >
                Review proposals
              </button>
            )}
            <button
              className="secondary-action"
              disabled={controlsDisabled}
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
            {workspace.document.content_type !== 'application/pdf' && (
              <button
                className="primary-button"
                disabled={controlsDisabled || creationOpen || !dirty || !workspace.can_update}
                onClick={() => {
                  void enqueue(save)
                }}
              >
                Save
              </button>
            )}
          </div>
        </header>
        <div className="mcp-status" role="status" hidden={creationOpen || assistantOpen}>
          {navigating
            ? 'Changing view'
            : workspace.document.content_type === 'application/pdf'
              ? 'PDF source is immutable'
              : !workspace.can_update
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
                disabled={controlsDisabled}
                onClick={() => {
                  void enqueue(retryAction.current ?? (saveAttempt.current ? save : checkpoint))
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
        <div className={`mcp-document-body${workspace.comparison ? ' mcp-with-comparison' : ''}`}>
          {creationOpen && (
            <NewDocument
              key={`${workspace.workspace_id}-${creationGeneration}`}
              app={app}
              workspace={workspace}
              onUnsavedChange={(value) => {
                unsavedCreation.current = value
              }}
              onCreated={async (created) => {
                unsavedCreation.current = false
                await enqueue(() =>
                  navigate((state) => ({
                    type: 'open',
                    workspace_id: state.workspace_id,
                    document_id: created.document_id,
                    expected_layout_version: state.layout.version,
                  })),
                )
              }}
              onClose={() => {
                setCreationOpen(false)
                creationTrigger.current?.focus()
              }}
            />
          )}
          <AssistantPane
            key={`assistant-${workspace.workspace_id}`}
            app={app}
            workspace={workspace}
            active={assistantOpen}
            selection={assistantSelection}
            dirtyDocument={dirty}
            onUnsavedChange={(value) => {
              unsavedMessage.current = value
            }}
            onAccepted={async () => {
              await enqueue(async () => {
                await action({ type: 'refresh', workspace_id: workspace.workspace_id })
              })
            }}
            onReview={openAssistantProposal}
            onClose={() => {
              setAssistantOpen(false)
              assistantTrigger.current?.focus()
            }}
          />
          {workspace.document.content_type === 'text/markdown' && (
            <ProposalReview
              key={workspace.workspace_id}
              app={app}
              workspace={workspace}
              active={reviewOpen}
              initialProposalId={reviewProposalId}
              initialContent={text}
              dirtyDocument={dirty}
              onUnsavedChange={(value) => {
                unsavedReview.current = value
              }}
              onApplied={async () => {
                await enqueue(async () => {
                  await action({ type: 'refresh', workspace_id: workspace.workspace_id }, true)
                })
              }}
              onClose={() => {
                setReviewOpen(false)
                reviewTrigger.current?.focus()
              }}
            />
          )}
          <section
            className="mcp-editor"
            aria-label="Document editor"
            hidden={reviewOpen || creationOpen || assistantOpen}
          >
            {workspace.document.content_type === 'application/pdf' && workspace.location.kind === 'pdf' ? (
              <PdfPane
                key={workspace.workspace_id}
                app={app}
                workspace={workspace}
                location={workspace.location}
                onLocation={(value) => {
                  if (current.current?.workspace_id !== workspace.workspace_id) return
                  location.current = value
                  setLocationChanged((version) => version + 1)
                }}
                onUnsavedChange={(value) => {
                  unsavedPdfNote.current = value
                }}
                disabled={navigating}
                onSelectionChange={(text, page) => {
                  pdfSelection.current = { text, pdf_page_number: page }
                }}
              />
            ) : workspace.can_update && workspace.location.kind === 'text' ? (
              <MarkdownEditor
                key={workspace.workspace_id}
                value={text}
                initialViewState={{
                  anchor: workspace.location.anchor,
                  head: workspace.location.head,
                  scrollTop: workspace.location.scroll_top,
                }}
                onViewStateChange={(value) => {
                  if (current.current?.workspace_id !== workspace.workspace_id) return
                  location.current = {
                    kind: 'text',
                    anchor: value.anchor,
                    head: value.head,
                    scroll_top: value.scrollTop,
                  }
                  setLocationChanged((version) => version + 1)
                }}
                readOnly={navigating}
                onChange={(value) => {
                  content.current = value
                  setText(value)
                }}
              />
            ) : (
              <pre>{text}</pre>
            )}
          </section>
          {workspace.comparison && (
            <details
              className="mcp-comparison"
              hidden={reviewOpen || creationOpen || assistantOpen}
              key={workspace.comparison.workspace_id}
              open={window.matchMedia('(min-width: 601px)').matches}
            >
              <summary>Comparison</summary>
              <section aria-label="Comparison document">
                <h2 title={workspace.comparison.document.title}>{workspace.comparison.document.title}</h2>
                <p className="mcp-path" title={workspace.comparison.document.path ?? ''}>
                  {workspace.comparison.document.path}
                </p>
                <p>{workspace.comparison.draft === null ? 'Saved revision' : 'Draft checkpoint'}</p>
                {workspace.comparison.document.content_type === 'application/pdf' &&
                workspace.comparison.location.kind === 'pdf' ? (
                  <PdfPane
                    app={app}
                    workspace={{ ...workspace, ...workspace.comparison, comparison: null }}
                    location={workspace.comparison.location}
                    readOnly
                    onLocation={() => {}}
                  />
                ) : (
                  <pre>{workspace.comparison.draft ?? workspace.comparison.document.content}</pre>
                )}
                <div className="mcp-controls">
                  <button
                    className="secondary-action"
                    disabled={controlsDisabled}
                    onClick={() => {
                      const target = workspace.comparison?.workspace_id
                      if (target) void activate(target)
                    }}
                  >
                    Edit this document
                  </button>
                  <button
                    className="secondary-action"
                    disabled={controlsDisabled}
                    onClick={() => {
                      void enqueue(() =>
                        navigate((state) => ({
                          type: 'compare',
                          workspace_id: state.workspace_id,
                          target_workspace_id: null,
                          expected_layout_version: state.layout.version,
                        })),
                      )
                    }}
                  >
                    Remove comparison
                  </button>
                </div>
              </section>
            </details>
          )}
        </div>
        {dirty && !creationOpen && !assistantOpen && (
          <footer className="mcp-document-footer">
            {dirty && !discarding && (
              <button className="secondary-action" disabled={navigating} onClick={() => setDiscarding(true)}>
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
                <button
                  className="secondary-action"
                  disabled={navigating}
                  onClick={() => setDiscarding(false)}
                >
                  Keep editing
                </button>
                <button
                  className="secondary-action"
                  disabled={controlsDisabled}
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
        )}
      </div>
    </main>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('MCP App root is missing')
createRoot(root).render(<DocumentApp />)
