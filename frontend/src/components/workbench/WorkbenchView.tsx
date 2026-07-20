import { useEffect } from 'react'
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  Columns2,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  PinOff,
  RotateCcw,
  Rows2,
  X,
} from 'lucide-react'
import { Group as PanelGroup, Panel, Separator } from 'react-resizable-panels'
import { api, type Document } from '../../api'
import { useDocumentSession, useDocumentSessions } from '../../documentSessions'
import { useTheme } from '../../theme'
import {
  collectGroups,
  useWorkbench,
  useWorkbenchActions,
  type GroupNode,
  type LayoutNode,
  type WorkbenchTab,
} from '../../workbench'
import {
  canSplitActiveGroup,
  minimumHorizontalGroupWidth,
  minimumVerticalGroupHeight,
} from '../../splitPolicy'
import { useMediaQuery } from '../../useMediaQuery'
import { ActionMenu, ActionMenuItem } from '../ActionMenu'
import { DocumentWorkspace } from '../document/DocumentWorkspace'
import { DocumentInspector } from '../document/DocumentInspector'
import { ResizeHandle } from '../ResizeHandle'
import { EditorGroupErrorBoundary } from './EditorGroupErrorBoundary'

export function WorkbenchView({ routeDocumentId }: { routeDocumentId: string }) {
  const workbench = useWorkbench()
  const { ensureDocumentOpen } = useWorkbenchActions()
  const isHydrated = collectGroups(workbench.root).some((group) =>
    group.tabs.some((tab) => tab.documentId === routeDocumentId),
  )

  useEffect(() => ensureDocumentOpen(routeDocumentId), [ensureDocumentOpen, routeDocumentId])

  if (!isHydrated) return <div className="center-message">Opening document…</div>
  return (
    <div className="document-workbench split-workbench">
      <LayoutRenderer node={workbench.root} />
    </div>
  )
}

function LayoutRenderer({ node }: { node: LayoutNode }) {
  const workbench = useWorkbench()
  const stackNarrowHorizontalSplit = useMediaQuery('(max-width: 859px)')
  if (node.kind === 'group') {
    return <EditorGroupView key={node.id} group={node} />
  }
  const renderedDirection =
    node.direction === 'horizontal' && stackNarrowHorizontalSplit ? 'vertical' : node.direction
  return (
    <PanelGroup
      className="split-panel-group"
      orientation={renderedDirection}
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
        minSize={`${renderedDirection === 'horizontal' ? minimumHorizontalGroupWidth : minimumVerticalGroupHeight}px`}
      >
        <LayoutRenderer node={node.first} />
      </Panel>
      <Separator
        className={`split-separator ${renderedDirection}`}
        aria-label={`Resize ${renderedDirection} split`}
      >
        <span />
      </Separator>
      <Panel
        id={node.second.id}
        defaultSize={`${100 - node.ratio}%`}
        minSize={`${renderedDirection === 'horizontal' ? minimumHorizontalGroupWidth : minimumVerticalGroupHeight}px`}
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
  const showTabStrip = group.tabs.length > 1
  const activeDocumentId = group.activeTabId
  const showInspector = group.id === workbench.activeGroupId && groups.length === 1
  const activeDocumentQuery = useQuery({
    queryKey: ['document', activeDocumentId],
    queryFn: () => api.getDocument(activeDocumentId as string),
    enabled: Boolean(activeDocumentId),
  })
  const isPdf = activeDocumentQuery.data?.content_type === 'application/pdf'
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
  const resetKey = `${group.id}:${activeDocumentId ?? 'empty'}`
  const recover = async () => {
    const fallback = groups.find((candidate) => candidate.id !== group.id)?.activeTabId
    if (groups.length > 1) workbench.closeGroup(group.id)
    else workbench.resetLayout()
    if (fallback) {
      await navigate({ to: '/documents/$documentId', params: { documentId: fallback }, replace: true })
    } else {
      await navigate({ to: '/', replace: true })
    }
  }
  return (
    <section
      className={group.id === workbench.activeGroupId ? 'editor-group active' : 'editor-group'}
      onPointerDown={() => workbench.setActiveGroup(group.id)}
    >
      {showTabStrip && (
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
          onSplit={(direction) => {
            if (canSplitActiveGroup(direction)) {
              workbench.splitGroup(group.id, direction, activeDocumentId ?? undefined)
            }
          }}
          onCloseGroup={() => void closeGroup()}
        />
      )}
      {/* The editor remounts per document (keyed), but the inspector is a sibling
          that persists across tab switches so chat context and drafts survive. */}
      <div className={`document-layout tab-document-layout ${isPdf ? 'pdf-document-layout' : ''}`}>
        <EditorGroupErrorBoundary
          key={resetKey}
          groupId={group.id}
          resetKey={resetKey}
          onRecover={() => void recover()}
        >
          {activeDocumentId ? (
            <DocumentLoader
              key={`${group.id}:${activeDocumentId}`}
              documentId={activeDocumentId}
              canCloseGroup={groups.length > 1}
              onSplit={(direction) => {
                if (canSplitActiveGroup(direction)) {
                  workbench.splitGroup(group.id, direction, activeDocumentId)
                }
              }}
              onCloseGroup={() => void closeGroup()}
              onDeleted={() => void close(activeDocumentId)}
            />
          ) : (
            <div className="empty-editor-group">
              <strong>Empty group</strong>
              <p>Open a file from the explorer or close this group.</p>
            </div>
          )}
        </EditorGroupErrorBoundary>
        {showInspector && activeDocumentId && <GroupInspector documentId={activeDocumentId} />}
      </div>
    </section>
  )
}

function GroupInspector({ documentId }: { documentId: string }) {
  const queryClient = useQueryClient()
  const { preferences, updatePreferences } = useTheme()
  const { updateDocumentTitle } = useWorkbenchActions()
  const sessions = useDocumentSessions()
  const session = useDocumentSession(documentId)
  const documentQuery = useQuery({
    queryKey: ['document', documentId],
    queryFn: () => api.getDocument(documentId),
    // Keep the previously loaded document visible while switching tabs so the
    // inspector (and its persistent ChatKit instance) never unmounts on a cache miss.
    placeholderData: keepPreviousData,
  })
  const document = documentQuery.data
  if (!document) return null
  const content = session.content ?? document.content
  const selectedText =
    session.viewState && session.selection.selectedCharacters
      ? content.slice(
          Math.min(session.viewState.anchor, session.viewState.head),
          Math.max(session.viewState.anchor, session.viewState.head),
        )
      : ''
  const updateCachedDocument = (nextDocument: Document, replaceContent = false) => {
    queryClient.setQueryData(['document', documentId], nextDocument)
    sessions.acceptServerDocument(nextDocument, replaceContent)
    updateDocumentTitle(documentId, nextDocument.title)
    void queryClient.invalidateQueries({ queryKey: ['documents'] })
    void queryClient.invalidateQueries({ queryKey: ['history', documentId] })
    void queryClient.invalidateQueries({ queryKey: ['folders'] })
  }
  if (!preferences.rightVisible) {
    return (
      <aside className="right-rail">
        <button
          className="icon-button"
          aria-label="Open document sidebar"
          title="Open document inspector"
          onClick={() => updatePreferences({ rightVisible: true })}
        >
          <PanelRightOpen size={16} />
        </button>
      </aside>
    )
  }
  return (
    <>
      <ResizeHandle
        side="right"
        value={preferences.rightWidth}
        min={290}
        max={720}
        onChange={(rightWidth) => updatePreferences({ rightWidth })}
      />
      <DocumentInspector
        width={preferences.rightWidth}
        document={document}
        content={content}
        selectedText={selectedText}
        onCollapse={() => updatePreferences({ rightVisible: false })}
        onUpdated={updateCachedDocument}
        onFocusEditor={() => sessions.focusEditor(documentId)}
      />
    </>
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
      <ActionMenu
        label="Editor group actions"
        icon={<MoreHorizontal size={16} />}
        className="tab-actions-trigger"
      >
        {(close) => (
          <>
            <ActionMenuItem
              disabled={!activeTab}
              onSelect={() => {
                onPin(activeDocumentId)
                close()
              }}
            >
              {activeTab?.pinned ? <PinOff size={13} /> : <Pin size={13} />}{' '}
              {activeTab?.pinned ? 'Unpin tab' : 'Pin tab'}
            </ActionMenuItem>
            <ActionMenuItem
              disabled={!activeTab}
              onSelect={() => {
                onCloseOthers(activeDocumentId)
                close()
              }}
            >
              Close other tabs
            </ActionMenuItem>
            <ActionMenuItem
              disabled={!canReopen}
              onSelect={() => {
                onReopen()
                close()
              }}
            >
              <RotateCcw size={13} /> Reopen closed tab
            </ActionMenuItem>
            <hr />
            <ActionMenuItem
              disabled={!canSplitActiveGroup('horizontal')}
              onSelect={() => {
                onSplit('horizontal')
                close()
              }}
            >
              <Columns2 size={13} /> Split right
            </ActionMenuItem>
            <ActionMenuItem
              disabled={!canSplitActiveGroup('vertical')}
              onSelect={() => {
                onSplit('vertical')
                close()
              }}
            >
              <Rows2 size={13} /> Split down
            </ActionMenuItem>
            {canCloseGroup && (
              <ActionMenuItem
                onSelect={() => {
                  onCloseGroup()
                  close()
                }}
              >
                <PanelRightClose size={13} /> Close editor group
              </ActionMenuItem>
            )}
          </>
        )}
      </ActionMenu>
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
  canCloseGroup,
  onSplit,
  onCloseGroup,
  onDeleted,
}: {
  documentId: string
  canCloseGroup: boolean
  onSplit: (direction: 'horizontal' | 'vertical') => void
  onCloseGroup: () => void
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
      canCloseGroup={canCloseGroup}
      onSplit={onSplit}
      onCloseGroup={onCloseGroup}
      onDeleted={onDeleted}
    />
  )
}
