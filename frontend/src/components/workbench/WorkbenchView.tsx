import { useLayoutEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Columns2, MoreHorizontal, PanelRightClose, Pin, PinOff, RotateCcw, Rows2, X } from 'lucide-react'
import { Group as PanelGroup, Panel, Separator } from 'react-resizable-panels'
import { api } from '../../api'
import { useDocumentSession } from '../../documentSessions'
import {
  collectGroups,
  useWorkbench,
  type GroupNode,
  type LayoutNode,
  type WorkbenchTab,
} from '../../workbench'
import { DocumentWorkspace } from '../document/DocumentWorkspace'
import { EditorGroupErrorBoundary } from './EditorGroupErrorBoundary'

export function WorkbenchView({ routeDocumentId }: { routeDocumentId: string }) {
  const workbench = useWorkbench()
  const workbenchRef = useRef(workbench)
  const isHydrated = collectGroups(workbench.root).some((group) =>
    group.tabs.some((tab) => tab.documentId === routeDocumentId),
  )

  useLayoutEffect(() => {
    workbenchRef.current = workbench
  }, [workbench])
  useLayoutEffect(() => workbenchRef.current.ensureDocumentOpen(routeDocumentId), [routeDocumentId])

  if (!isHydrated) return <div className="center-message">Opening document…</div>
  return (
    <div className="document-workbench split-workbench">
      <LayoutRenderer node={workbench.root} />
    </div>
  )
}

function LayoutRenderer({ node }: { node: LayoutNode }) {
  const navigate = useNavigate()
  const workbench = useWorkbench()
  if (node.kind === 'group') {
    const resetKey = `${node.id}:${node.activeTabId ?? 'empty'}`
    const recover = async () => {
      const groups = collectGroups(workbench.root)
      const fallback = groups.find((group) => group.id !== node.id)?.activeTabId
      if (groups.length > 1) workbench.closeGroup(node.id)
      else workbench.resetLayout()
      if (fallback) {
        await navigate({ to: '/documents/$documentId', params: { documentId: fallback }, replace: true })
      } else {
        await navigate({ to: '/', replace: true })
      }
    }
    return (
      <EditorGroupErrorBoundary
        key={resetKey}
        groupId={node.id}
        resetKey={resetKey}
        onRecover={() => void recover()}
      >
        <EditorGroupView group={node} />
      </EditorGroupErrorBoundary>
    )
  }
  return (
    <PanelGroup
      className="split-panel-group"
      orientation={node.direction}
      onLayoutChanged={(layout) => {
        const first = layout[node.first.id]
        const second = layout[node.second.id]
        if (first !== undefined && second !== undefined && first + second > 0) {
          workbench.setSplitRatio(node.id, (first / (first + second)) * 100)
        }
      }}
    >
      <Panel
        id={node.first.id}
        defaultSize={`${node.ratio}%`}
        minSize={node.direction === 'horizontal' ? '280px' : '220px'}
      >
        <LayoutRenderer node={node.first} />
      </Panel>
      <Separator
        className={`split-separator ${node.direction}`}
        aria-label={`Resize ${node.direction} split`}
      >
        <span />
      </Separator>
      <Panel
        id={node.second.id}
        defaultSize={`${100 - node.ratio}%`}
        minSize={node.direction === 'horizontal' ? '280px' : '220px'}
      >
        <LayoutRenderer node={node.second} />
      </Panel>
    </PanelGroup>
  )
}

function EditorGroupView({ group }: { group: GroupNode }) {
  const navigate = useNavigate()
  const workbench = useWorkbench()
  const groups = collectGroups(workbench.root)
  const activeDocumentId = group.activeTabId
  const activate = async (documentId: string) => {
    workbench.activateTab(group.id, documentId)
    await navigate({ to: '/documents/$documentId', params: { documentId } })
  }
  const close = async (documentId: string) => {
    const remaining = group.tabs.filter((tab) => tab.documentId !== documentId)
    const next = remaining.at(-1)?.documentId
    workbench.closeTab(group.id, documentId)
    if (group.activeTabId === documentId) {
      if (next) {
        await navigate({ to: '/documents/$documentId', params: { documentId: next }, replace: true })
      } else if (groups.length === 1) {
        await navigate({ to: '/', replace: true })
      }
    }
  }
  const closeGroup = async () => {
    const fallback = groups.find((candidate) => candidate.id !== group.id)?.activeTabId
    workbench.closeGroup(group.id)
    if (fallback) {
      await navigate({ to: '/documents/$documentId', params: { documentId: fallback }, replace: true })
    } else {
      await navigate({ to: '/', replace: true })
    }
  }
  const reopen = async () => {
    const documentId = workbench.reopenClosedTab()
    if (documentId) await navigate({ to: '/documents/$documentId', params: { documentId } })
  }
  return (
    <section
      className={group.id === workbench.activeGroupId ? 'editor-group active' : 'editor-group'}
      onPointerDown={() => workbench.setActiveGroup(group.id)}
    >
      <TabStrip
        tabs={group.tabs}
        activeDocumentId={activeDocumentId ?? ''}
        canReopen={workbench.recentlyClosed.length > 0}
        canCloseGroup={groups.length > 1}
        onActivate={(documentId) => void activate(documentId)}
        onClose={(documentId) => void close(documentId)}
        onCloseOthers={(documentId) => workbench.closeOtherTabs(group.id, documentId)}
        onPin={(documentId) => workbench.togglePinned(group.id, documentId)}
        onReopen={() => void reopen()}
        onSplit={(direction) => workbench.splitGroup(group.id, direction, activeDocumentId ?? undefined)}
        onCloseGroup={() => void closeGroup()}
      />
      {activeDocumentId ? (
        <DocumentLoader
          key={`${group.id}:${activeDocumentId}`}
          documentId={activeDocumentId}
          showInspector={group.id === workbench.activeGroupId}
          onDeleted={() => void close(activeDocumentId)}
        />
      ) : (
        <div className="empty-editor-group">
          <strong>Empty group</strong>
          <p>Open a file from the explorer or close this group.</p>
        </div>
      )}
    </section>
  )
}

function TabStrip({
  tabs,
  activeDocumentId,
  canReopen,
  canCloseGroup,
  onActivate,
  onClose,
  onCloseOthers,
  onPin,
  onReopen,
  onSplit,
  onCloseGroup,
}: {
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
  const activeTab = tabs.find((tab) => tab.documentId === activeDocumentId)
  return (
    <div className="editor-tabbar" role="tablist" aria-label="Open documents">
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
        <button aria-label="Split right" title="Split right" onClick={() => onSplit('horizontal')}>
          <Columns2 size={14} />
        </button>
        <button aria-label="Split down" title="Split down" onClick={() => onSplit('vertical')}>
          <Rows2 size={14} />
        </button>
        {canCloseGroup && (
          <button aria-label="Close editor group" title="Close editor group" onClick={onCloseGroup}>
            <PanelRightClose size={14} />
          </button>
        )}
      </div>
      <details className="tab-actions">
        <summary aria-label="Tab actions" title="Tab actions">
          <MoreHorizontal size={16} />
        </summary>
        <div>
          <button disabled={!activeTab} onClick={() => onPin(activeDocumentId)}>
            {activeTab?.pinned ? <PinOff size={13} /> : <Pin size={13} />}{' '}
            {activeTab?.pinned ? 'Unpin tab' : 'Pin tab'}
          </button>
          <button disabled={!activeTab} onClick={() => onCloseOthers(activeDocumentId)}>
            Close other tabs
          </button>
          <button disabled={!canReopen} onClick={onReopen}>
            <RotateCcw size={13} /> Reopen closed tab
          </button>
        </div>
      </details>
    </div>
  )
}

function DocumentTab({
  tab,
  active,
  onActivate,
  onClose,
}: {
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
      {!tab.pinned && (
        <button
          className="tab-close"
          aria-label={`Close ${tab.title}`}
          title="Close"
          onClick={() => onClose(tab.documentId)}
        >
          <X size={12} />
        </button>
      )}
    </div>
  )
}

function DocumentLoader({
  documentId,
  showInspector,
  onDeleted,
}: {
  documentId: string
  showInspector: boolean
  onDeleted: () => void
}) {
  const documentQuery = useQuery({
    queryKey: ['document', documentId],
    queryFn: () => api.getDocument(documentId),
  })
  if (documentQuery.isLoading) return <div className="center-message">Opening document…</div>
  if (documentQuery.isError || !documentQuery.data) {
    return <div className="center-message error-text">Document could not be opened.</div>
  }
  return (
    <DocumentWorkspace
      initialDocument={documentQuery.data}
      showInspector={showInspector}
      onDeleted={onDeleted}
    />
  )
}
