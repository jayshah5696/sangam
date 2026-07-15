import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Columns2, MoreHorizontal, PanelRightClose, Pin, PinOff, RotateCcw, Rows2, X } from 'lucide-react'
import { Group as PanelGroup, Panel, Separator } from 'react-resizable-panels'
import { api, type Document, type Revision, type Tag } from '../api'
import type { MarkdownEditorHandle } from '../components/MarkdownEditor'
import { ResizeHandle } from '../components/ResizeHandle'
import { RevisionMergeView } from '../components/RevisionMergeView'
import { useDocumentSession, useDocumentSessions, type EditorMode, type SaveState } from '../documentSessions'
import { internalDocumentMarkdown } from '../internalLinks'
import { useTheme } from '../theme'
import { collectGroups, useWorkbench, type GroupNode, type LayoutNode, type WorkbenchTab } from '../workbench'

export const Route = createFileRoute('/documents/$documentId')({ component: DocumentPage })

const MarkdownPreview = lazy(() => import('../components/MarkdownPreview').then((module) => ({ default: module.MarkdownPreview })))
const MarkdownEditor = lazy(() => import('../components/MarkdownEditor').then((module) => ({ default: module.MarkdownEditor })))

function DocumentPage() {
  const { documentId: routeDocumentId } = Route.useParams()
  const workbench = useWorkbench()
  const workbenchRef = useRef(workbench)
  useEffect(() => { workbenchRef.current = workbench }, [workbench])

  useEffect(() => workbenchRef.current.ensureDocumentOpen(routeDocumentId), [routeDocumentId])

  return (
    <div className="document-workbench split-workbench">
      <LayoutRenderer node={workbench.root} routeDocumentId={routeDocumentId} />
    </div>
  )
}

function LayoutRenderer({ node, routeDocumentId }: { node: LayoutNode; routeDocumentId: string }) {
  const workbench = useWorkbench()
  if (node.kind === 'group') return <EditorGroupView group={node} routeDocumentId={routeDocumentId} />
  return (
    <PanelGroup
      className="split-panel-group"
      orientation={node.direction}
      onLayoutChanged={(layout) => {
        const first = layout[node.first.id]
        const second = layout[node.second.id]
        if (first !== undefined && second !== undefined && first + second > 0) workbench.setSplitRatio(node.id, (first / (first + second)) * 100)
      }}
    >
      <Panel id={node.first.id} defaultSize={`${node.ratio}%`} minSize={node.direction === 'horizontal' ? '280px' : '220px'}><LayoutRenderer node={node.first} routeDocumentId={routeDocumentId} /></Panel>
      <Separator className={`split-separator ${node.direction}`} aria-label={`Resize ${node.direction} split`}><span /></Separator>
      <Panel id={node.second.id} defaultSize={`${100 - node.ratio}%`} minSize={node.direction === 'horizontal' ? '280px' : '220px'}><LayoutRenderer node={node.second} routeDocumentId={routeDocumentId} /></Panel>
    </PanelGroup>
  )
}

function EditorGroupView({ group, routeDocumentId }: { group: GroupNode; routeDocumentId: string }) {
  const navigate = useNavigate()
  const workbench = useWorkbench()
  const groups = collectGroups(workbench.root)
  const activeDocumentId = group.activeTabId ?? (group.id === workbench.activeGroupId ? routeDocumentId : null)
  const activate = async (documentId: string) => {
    workbench.activateTab(group.id, documentId)
    await navigate({ to: '/documents/$documentId', params: { documentId } })
  }
  const close = async (documentId: string) => {
    const remaining = group.tabs.filter((tab) => tab.documentId !== documentId)
    const next = remaining.at(-1)?.documentId
    workbench.closeTab(group.id, documentId)
    if (group.activeTabId === documentId) {
      if (next) await navigate({ to: '/documents/$documentId', params: { documentId: next }, replace: true })
      else if (groups.length === 1) await navigate({ to: '/', replace: true })
    }
  }
  const closeGroup = async () => {
    const fallback = groups.find((candidate) => candidate.id !== group.id)?.activeTabId
    workbench.closeGroup(group.id)
    if (fallback) await navigate({ to: '/documents/$documentId', params: { documentId: fallback }, replace: true })
    else await navigate({ to: '/', replace: true })
  }
  const reopen = async () => {
    const documentId = workbench.reopenClosedTab()
    if (documentId) await navigate({ to: '/documents/$documentId', params: { documentId } })
  }
  return (
    <section className={group.id === workbench.activeGroupId ? 'editor-group active' : 'editor-group'} onPointerDown={() => workbench.setActiveGroup(group.id)}>
      <TabStrip
        groupId={group.id}
        tabs={group.tabs}
        activeDocumentId={activeDocumentId ?? ''}
        canReopen={workbench.recentlyClosed.length > 0}
        canCloseGroup={groups.length > 1}
        onActivate={(documentId) => void activate(documentId)}
        onClose={(documentId) => void close(documentId)}
        onCloseOthers={(documentId) => workbench.closeOtherTabs(group.id, documentId)}
        onPin={(documentId) => workbench.togglePinned(group.id, documentId)}
        onReopen={() => void reopen()}
        onSplit={(direction) => workbench.splitGroup(group.id, direction, activeDocumentId ?? routeDocumentId)}
        onCloseGroup={() => void closeGroup()}
      />
      {activeDocumentId ? <DocumentLoader key={`${group.id}:${activeDocumentId}`} documentId={activeDocumentId} showInspector={group.id === workbench.activeGroupId} onDeleted={() => void close(activeDocumentId)} /> : <div className="empty-editor-group"><strong>Empty group</strong><p>Open a file from the explorer or close this group.</p></div>}
    </section>
  )
}

function TabStrip({ groupId, tabs, activeDocumentId, canReopen, canCloseGroup, onActivate, onClose, onCloseOthers, onPin, onReopen, onSplit, onCloseGroup }: {
  groupId: string
  tabs: WorkbenchTab[]
  activeDocumentId: string
  canReopen: boolean
  canCloseGroup: boolean
  onActivate: (documentId: string) => void
  onClose: (documentId: string) => void
  onCloseOthers: (documentId: string) => void
  onPin: (documentId: string) => void
  onReopen: () => void
  onSplit: (direction: 'horizontal' | 'vertical') => void
  onCloseGroup: () => void
}) {
  const workbench = useWorkbench()
  return (
    <div className="editor-tabbar" role="tablist" aria-label="Open documents" onPointerDown={() => workbench.setActiveGroup(groupId)}>
      <div className="editor-tabs-scroll">
        {tabs.map((tab) => (
          <DocumentTab
            key={tab.documentId}
            tab={tab}
            active={activeDocumentId === tab.documentId}
            onActivate={onActivate}
            onClose={onClose}
          />
        ))}
      </div>
      <div className="group-actions">
        <button aria-label="Split right" title="Split right" onClick={() => onSplit('horizontal')}><Columns2 size={14} /></button>
        <button aria-label="Split down" title="Split down" onClick={() => onSplit('vertical')}><Rows2 size={14} /></button>
        {canCloseGroup && <button aria-label="Close editor group" title="Close editor group" onClick={onCloseGroup}><PanelRightClose size={14} /></button>}
      </div>
      <details className="tab-actions">
        <summary aria-label="Tab actions" title="Tab actions"><MoreHorizontal size={16} /></summary>
        <div>
          <button onClick={() => onPin(activeDocumentId)}>{tabs.find((tab) => tab.documentId === activeDocumentId)?.pinned ? <PinOff size={13} /> : <Pin size={13} />} {tabs.find((tab) => tab.documentId === activeDocumentId)?.pinned ? 'Unpin tab' : 'Pin tab'}</button>
          <button onClick={() => onCloseOthers(activeDocumentId)}>Close other tabs</button>
          <button disabled={!canReopen} onClick={onReopen}><RotateCcw size={13} /> Reopen closed tab</button>
        </div>
      </details>
    </div>
  )
}

function DocumentTab({ tab, active, onActivate, onClose }: {
  tab: WorkbenchTab
  active: boolean
  onActivate: (documentId: string) => void
  onClose: (documentId: string) => void
}) {
  const session = useDocumentSession(tab.documentId)
  const dirty = session.saveState !== 'saved'
  return (
    <div className={active ? 'editor-tab active' : 'editor-tab'}>
      <button role="tab" aria-selected={active} title={tab.title} onClick={() => onActivate(tab.documentId)}>
        {tab.pinned && <Pin size={10} />}
        <span>{tab.title}</span>
        {dirty && <i aria-label="Unsaved changes" />}
      </button>
      {!tab.pinned && <button className="tab-close" aria-label={`Close ${tab.title}`} title="Close" onClick={() => onClose(tab.documentId)}><X size={12} /></button>}
    </div>
  )
}

function DocumentLoader({ documentId, showInspector, onDeleted }: { documentId: string; showInspector: boolean; onDeleted: () => void }) {
  const documentQuery = useQuery({ queryKey: ['document', documentId], queryFn: () => api.getDocument(documentId) })
  if (documentQuery.isLoading) return <div className="center-message">Opening document…</div>
  if (documentQuery.isError || !documentQuery.data) return <div className="center-message error-text">Document could not be opened.</div>
  return <DocumentWorkspace initialDocument={documentQuery.data} showInspector={showInspector} onDeleted={onDeleted} />
}

function DocumentWorkspace({ initialDocument, showInspector, onDeleted }: { initialDocument: Document; showInspector: boolean; onDeleted: () => void }) {
  const documentId = initialDocument.document_id
  const queryClient = useQueryClient()
  const { preferences, updatePreferences } = useTheme()
  const workbench = useWorkbench()
  const sessions = useDocumentSessions()
  const session = useDocumentSession(documentId)
  const editorRef = useRef<MarkdownEditorHandle>(null)
  const workbenchRef = useRef(workbench)
  useEffect(() => { workbenchRef.current = workbench }, [workbench])
  const document = queryClient.getQueryData<Document>(['document', documentId]) ?? initialDocument
  const content = session.content ?? document.content
  const saveState = session.saveState
  const mode = session.mode
  const selection = session.selection
  const compareFrom = session.compareFrom
  const compareTo = session.compareTo ?? document.current_revision_id
  const historyQuery = useQuery({ queryKey: ['history', documentId], queryFn: () => api.history(documentId) })
  const tagsQuery = useQuery({ queryKey: ['tags'], queryFn: api.listTags })
  const documentsQuery = useQuery({ queryKey: ['documents', 'links'], queryFn: api.listDocuments })
  const [materializePath, setMaterializePath] = useState('projects/first-document.md')
  const [linkTarget, setLinkTarget] = useState('')

  useEffect(() => { void sessions.initializeDocument(initialDocument) }, [initialDocument, sessions])
  useEffect(() => workbenchRef.current.updateDocumentTitle(documentId, document.title), [documentId, document.title])

  const updateCachedDocument = (nextDocument: Document, replaceContent = false) => {
    queryClient.setQueryData(['document', documentId], nextDocument)
    sessions.acceptServerDocument(nextDocument, replaceContent)
    workbench.updateDocumentTitle(documentId, nextDocument.title)
    void queryClient.invalidateQueries({ queryKey: ['documents'] })
    void queryClient.invalidateQueries({ queryKey: ['history', documentId] })
    void queryClient.invalidateQueries({ queryKey: ['folders'] })
  }
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (content !== document.content) event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [content, document.content])

  const materialize = useMutation({ mutationFn: ({ base, path }: { base: Document; path: string }) => api.materializeDocument(base, path), onSuccess: (nextDocument) => updateCachedDocument(nextDocument) })
  const restore = useMutation({
    mutationFn: ({ base, revisionId }: { base: Document; revisionId: string }) => api.restore(base, revisionId),
    onSuccess: (nextDocument) => {
      updateCachedDocument(nextDocument, true)
      sessions.updateSession(documentId, { compareFrom: undefined })
    },
  })
  const reloadAfterConflict = async () => {
    const current = await api.getDocument(documentId)
    updateCachedDocument(current, true)
  }
  const handleEditorChange = (nextContent: string) => {
    sessions.updateSession(documentId, {
      content: nextContent,
      baseRevisionId: session.baseRevisionId ?? document.current_revision_id,
    })
  }
  const insertLink = () => {
    const target = documentsQuery.data?.find((candidate) => candidate.document_id === linkTarget)
    if (target) editorRef.current?.insertText(internalDocumentMarkdown(target))
  }

  return (
    <div className="document-layout tab-document-layout">
      <section className="document-workspace">
        <header className="document-header">
          <div><p className="eyebrow">{document.path ?? 'Unmaterialized draft'}</p><h1>{document.title}</h1><div className="document-badges">{document.category && <span className="category-badge">{document.category}</span>}{document.tags.map((tag) => <span className="tag-badge" key={tag.tag_id}><i style={{ background: tag.color }} />{tag.name}</span>)}<span className="actor-badge">Edited by {document.updated_by_name}</span><time>{new Date(document.updated_at).toLocaleString()}</time></div></div>
          <span className={`save-state ${saveState}`}>{saveLabel(saveState)}</span>
        </header>
        <DocumentToolbar document={document} content={content} saveState={saveState} mode={mode} onMode={(nextMode) => sessions.updateSession(documentId, { mode: nextMode })} onUpdated={(updated) => updateCachedDocument(updated)} onDeleted={async () => { await queryClient.invalidateQueries({ queryKey: ['documents'] }); onDeleted() }} />
        {saveState === 'conflict' && <div className="notice conflict-notice">This document changed elsewhere. Your text is still here.<button onClick={() => void reloadAfterConflict()}>Reload current revision</button></div>}
        {saveState === 'failed' && <div className="notice error-notice">Save failed. Your text remains in this editor; edit again to retry.</div>}
        {saveState === 'offline' && <div className="notice offline-notice">You are offline. Changes remain in this browser and will save after reconnecting.</div>}
        {!document.path && <form className="materialize-bar" onSubmit={(event) => { event.preventDefault(); materialize.mutate({ base: document, path: materializePath }) }}><input aria-label="Workspace path" value={materializePath} onChange={(event) => setMaterializePath(event.target.value)} /><button disabled={materialize.isPending || saveState !== 'saved'}>{materialize.isPending ? 'Saving file…' : 'Save to workspace'}</button></form>}
        {mode !== 'preview' && <div className="editor-tools"><label>Internal link<select value={linkTarget} onChange={(event) => setLinkTarget(event.target.value)}><option value="">Choose a document…</option>{documentsQuery.data?.filter((candidate) => candidate.document_id !== documentId).map((candidate) => <option key={candidate.document_id} value={candidate.document_id}>{candidate.path ?? candidate.title}</option>)}</select></label><button type="button" disabled={!linkTarget} onClick={insertLink}>Insert link</button><span>Ln {selection.line}, Col {selection.column}{selection.selectedCharacters ? ` · ${selection.selectedCharacters} selected` : ''}</span><kbd>⌘F</kbd><small>find/replace</small></div>}
        <div className={`editing-surface mode-${mode}`}>
          {mode !== 'preview' && <Suspense fallback={<div className="editor muted">Preparing editor…</div>}><MarkdownEditor ref={editorRef} value={content} onChange={handleEditorChange} onSelectionChange={(nextSelection) => sessions.updateSession(documentId, { selection: nextSelection })} initialViewState={session.viewState} onViewStateChange={(viewState) => sessions.updateSession(documentId, { viewState })} /></Suspense>}
          {mode !== 'edit' && <Suspense fallback={<div className="markdown-preview muted">Preparing preview…</div>}><MarkdownPreview content={content} /></Suspense>}
        </div>
      </section>
      {showInspector && (preferences.rightVisible ? <><ResizeHandle side="right" value={preferences.rightWidth} min={290} max={720} onChange={(rightWidth) => updatePreferences({ rightWidth })} /><DocumentInspector width={preferences.rightWidth} document={document} content={content} tags={tagsQuery.data ?? []} history={historyQuery.data ?? []} saveState={saveState} compareFrom={compareFrom} compareTo={compareTo} onCollapse={() => updatePreferences({ rightVisible: false })} onUpdated={updateCachedDocument} onComparison={(from, to) => sessions.updateSession(documentId, { compareFrom: from, compareTo: to })} onCloseComparison={() => sessions.updateSession(documentId, { compareFrom: undefined, compareTo: undefined })} onCopy={(revision) => { sessions.updateSession(documentId, { content: revision.content, baseRevisionId: document.current_revision_id }); editorRef.current?.focus() }} onRestore={(revisionId) => restore.mutate({ base: document, revisionId })} restoring={restore.isPending} /></> : <aside className="right-rail"><button className="icon-button" aria-label="Open document sidebar" onClick={() => updatePreferences({ rightVisible: true })}>‹</button></aside>)}
    </div>
  )
}

function DocumentToolbar({ document, content, saveState, mode, onMode, onUpdated, onDeleted }: { document: Document; content: string; saveState: SaveState; mode: EditorMode; onMode: (mode: EditorMode) => void; onUpdated: (document: Document) => void; onDeleted: () => Promise<void> }) {
  const navigate = useNavigate()
  const [title, setTitle] = useState(document.title)
  const [path, setPath] = useState(document.path ?? '')
  const rename = useMutation({ mutationFn: () => api.updateDocument(document, content, title), onSuccess: onUpdated })
  const move = useMutation({ mutationFn: () => api.moveDocument(document, path), onSuccess: onUpdated })
  const duplicate = useMutation({ mutationFn: () => api.duplicateDocument(document), onSuccess: async (created) => navigate({ to: '/documents/$documentId', params: { documentId: created.document_id } }) })
  const remove = useMutation({ mutationFn: () => api.deleteDocument(document), onSuccess: onDeleted })
  const busy = saveState !== 'saved' || rename.isPending || move.isPending || duplicate.isPending || remove.isPending
  return <div className="document-toolbar"><div className="mode-switch" aria-label="Editor view">{(['edit', 'split', 'preview'] as const).map((candidate) => <button key={candidate} className={mode === candidate ? 'active' : ''} onClick={() => onMode(candidate)}>{candidate}</button>)}</div><details className="document-actions"><summary>Document actions</summary><div className="action-popover"><label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label><button disabled={busy || !title.trim() || title === document.title} onClick={() => rename.mutate()}>Rename</button>{document.path && <><label>Path<input value={path} onChange={(event) => setPath(event.target.value)} /></label><button disabled={busy || path === document.path} onClick={() => move.mutate()}>Move</button></>}<button disabled={busy} onClick={() => duplicate.mutate()}>Duplicate as draft</button><button className="danger-button" disabled={busy} onClick={() => { if (window.confirm(`Move “${document.title}” to trash?`)) remove.mutate() }}>Move to trash</button>{(rename.isError || move.isError || duplicate.isError || remove.isError) && <p className="error-text">The document action could not be completed.</p>}</div></details></div>
}

function HistoryList({ history, currentRevisionId, busy, onCompare, onCopy, onRestore }: { history: Revision[]; currentRevisionId: string; busy: boolean; onCompare: (revisionId: string) => void; onCopy: (revision: Revision) => void; onRestore: (revisionId: string) => void }) {
  return <section className="history-section"><p className="eyebrow">History</p>{history.map((revision) => <article className="revision" key={revision.revision_id}><div><strong>{revision.operation}</strong><time>{new Date(revision.created_at).toLocaleString()}</time></div><p>{revision.actor_id}{revision.summary ? ` · ${revision.summary}` : ''}</p>{revision.revision_id !== currentRevisionId && <div className="revision-actions"><button onClick={() => onCompare(revision.revision_id)}>Compare</button><button onClick={() => onCopy(revision)}>Copy to editor</button><button disabled={busy} onClick={() => onRestore(revision.revision_id)}>Restore</button></div>}</article>)}</section>
}

function DocumentInspector({ width, document, content, tags, history, saveState, compareFrom, compareTo, onCollapse, onUpdated, onComparison, onCloseComparison, onCopy, onRestore, restoring }: {
  width: number
  document: Document
  content: string
  tags: Tag[]
  history: Revision[]
  saveState: SaveState
  compareFrom?: string
  compareTo: string
  onCollapse: () => void
  onUpdated: (document: Document) => void
  onComparison: (from: string, to: string) => void
  onCloseComparison: () => void
  onCopy: (revision: Revision) => void
  onRestore: (revisionId: string) => void
  restoring: boolean
}) {
  const [tab, setTab] = useState<'properties' | 'outline' | 'history'>('properties')
  const headings = content.split('\n').map((line, index) => { const match = /^(#{1,6})\s+(.+)/.exec(line); return match ? { level: match[1]!.length, text: match[2]!, line: index + 1 } : null }).filter((heading): heading is { level: number; text: string; line: number } => Boolean(heading))
  const fromRevision = history.find((revision) => revision.revision_id === compareFrom)
  const toRevision = history.find((revision) => revision.revision_id === compareTo)
  return (
    <aside className="history-panel document-inspector" style={{ width }}>
      <div className="right-panel-header"><p className="eyebrow">Inspector</p><button className="icon-button" aria-label="Collapse document inspector" onClick={onCollapse}>›</button></div>
      <div className="inspector-tabs" role="tablist" aria-label="Document inspector">{(['properties', 'outline', 'history'] as const).map((candidate) => <button role="tab" aria-selected={tab === candidate} className={tab === candidate ? 'active' : ''} key={candidate} onClick={() => setTab(candidate)}>{candidate}</button>)}</div>
      {tab === 'properties' && <MetadataEditor key={document.metadata_version} document={document} tags={tags} onUpdated={onUpdated} />}
      {tab === 'outline' && <section className="outline-panel">{headings.map((heading) => <button key={`${heading.line}:${heading.text}`} style={{ paddingLeft: 8 + (heading.level - 1) * 10 }}><span>{heading.text}</span><small>Ln {heading.line}</small></button>)}{headings.length === 0 && <p className="small-muted">No Markdown headings in this document.</p>}</section>}
      {tab === 'history' && <><section className="compare-controls"><label>From<select value={compareFrom ?? ''} onChange={(event) => { if (event.target.value) onComparison(event.target.value, compareTo) }}><option value="">Choose a revision…</option>{history.map((revision) => <option key={revision.revision_id} value={revision.revision_id}>{revision.operation} · {new Date(revision.created_at).toLocaleString()}</option>)}</select></label><label>To<select value={compareTo} onChange={(event) => { if (compareFrom) onComparison(compareFrom, event.target.value) }}>{history.map((revision) => <option key={revision.revision_id} value={revision.revision_id}>{revision.operation} · {new Date(revision.created_at).toLocaleString()}</option>)}</select></label>{fromRevision && toRevision && fromRevision.revision_id !== toRevision.revision_id && <button onClick={onCloseComparison}>Close comparison</button>}</section>{fromRevision && toRevision && fromRevision.revision_id !== toRevision.revision_id && <RevisionMergeView original={fromRevision.content} modified={toRevision.content} />}<HistoryList history={history} currentRevisionId={document.current_revision_id} busy={restoring || saveState !== 'saved'} onCompare={(revisionId) => onComparison(revisionId, document.current_revision_id)} onCopy={onCopy} onRestore={onRestore} /></>}
    </aside>
  )
}

function MetadataEditor({ document, tags, onUpdated }: { document: Document; tags: Tag[]; onUpdated: (document: Document) => void }) {
  const [category, setCategory] = useState(document.category ?? '')
  const [selectedTags, setSelectedTags] = useState(document.tags.map((tag) => tag.tag_id))
  const mutation = useMutation({ mutationFn: () => api.updateDocumentMetadata(document, category || null, selectedTags), onSuccess: onUpdated })
  return <section className="metadata-editor"><label><span>Category</span><input value={category} placeholder="e.g. Research" onChange={(event) => setCategory(event.target.value)} /></label><fieldset><legend>Tags</legend>{tags.length === 0 && <p className="small-muted">Create tags in Workspace settings.</p>}<div className="tag-checklist">{tags.map((tag) => <label key={tag.tag_id}><input type="checkbox" checked={selectedTags.includes(tag.tag_id)} onChange={() => setSelectedTags((current) => current.includes(tag.tag_id) ? current.filter((id) => id !== tag.tag_id) : [...current, tag.tag_id])} /><i style={{ background: tag.color }} />{tag.name}</label>)}</div></fieldset><button className="panel-button" onClick={() => mutation.mutate()} disabled={mutation.isPending}>{mutation.isPending ? 'Saving…' : 'Save organization'}</button>{mutation.isError && <p className="error-text">{mutation.error.message}</p>}</section>
}

function saveLabel(state: SaveState) {
  return { saved: 'Saved', dirty: 'Unsaved changes', saving: 'Saving…', conflict: 'Conflict', failed: 'Save failed', offline: 'Offline · unsaved' }[state]
}
