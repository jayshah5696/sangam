import { useEffect } from 'react'
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  Columns2,
  History,
  ListTree,
  MessageSquare,
  MoreHorizontal,
  NotebookTabs,
  PanelRightClose,
  Pin,
  PinOff,
  RotateCcw,
  Rows2,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import { Group as PanelGroup, Panel, Separator } from 'react-resizable-panels'
import { api, type Document } from '../../api'
import { useDocumentSession, useDocumentSessions } from '../../documentSessions'
import { PdfResearchProvider } from '../../pdfResearchState'
import { useTheme, type InspectorTab } from '../../theme'
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
import { activateTabFromKeyboard } from '../tabKeyboard'
import { StateMessage } from '../ui/StateMessage'
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
  const showTabStrip = group.tabs.length > 1 || groups.length > 1
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
      <div
        className={`document-layout tab-document-layout ${isPdf ? 'pdf-document-layout' : ''}`}
        id={showTabStrip ? `editor-panel-${group.id}` : undefined}
        role={showTabStrip ? 'tabpanel' : undefined}
        aria-labelledby={
          showTabStrip && activeDocumentId ? `editor-tab-${group.id}-${activeDocumentId}` : undefined
        }
      >
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
  const navigate = useNavigate()
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
  const pdfAnnotationsQuery = useQuery({
    queryKey: ['annotations', documentId, session.pdfAnnotationQuery ?? ''],
    queryFn: () => api.listAnnotations(documentId, session.pdfAnnotationQuery ?? ''),
    enabled: document?.content_type === 'application/pdf',
  })
  if (!document) return null
  const content = session.content ?? document.content
  const updatePdfState = (patch: Partial<NonNullable<typeof session.pdfState>>) => {
    const current = sessions.getSession(documentId).pdfState ?? {
      pageNumber: 1,
      scale: 1,
      zoomMode: 'fit-width' as const,
      scrollTop: 0,
    }
    sessions.updateSession(documentId, { pdfState: { ...current, ...patch } })
  }
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
    const openToTab = (tabName: InspectorTab) => {
      updatePreferences({ rightVisible: true, rightTab: tabName })
    }
    return (
      <aside className="right-rail" aria-label="Collapsed inspector tools">
        <button
          className="icon-button"
          aria-label="Document properties"
          title="Document properties"
          onClick={() => openToTab('properties')}
        >
          <SlidersHorizontal size={15} />
        </button>
        {document.content_type === 'application/pdf' && (
          <button
            className="icon-button"
            aria-label="PDF research"
            title="PDF research"
            onClick={() => openToTab('research')}
          >
            <NotebookTabs size={15} />
          </button>
        )}
        <button
          className="icon-button"
          aria-label="Document outline"
          title="Document outline"
          onClick={() => openToTab('outline')}
        >
          <ListTree size={15} />
        </button>
        <button
          className="icon-button"
          aria-label="Revision history"
          title="Revision history"
          onClick={() => openToTab('history')}
        >
          <History size={15} />
        </button>
        <button
          className="icon-button"
          aria-label="Ask about this document"
          title="Ask about this document"
          onClick={() =>
            void navigate({
              to: '/chat',
              search: {
                document: document.document_id,
                revision: document.current_revision_id,
                returnTo: `/documents/${document.document_id}`,
              },
            })
          }
        >
          <MessageSquare size={15} />
        </button>
      </aside>
    )
  }
  return (
    <>
      <button
        type="button"
        className="inspector-backdrop"
        aria-label="Close document inspector"
        onClick={() => updatePreferences({ rightVisible: false })}
      />
      <ResizeHandle
        side="right"
        value={preferences.rightWidth}
        min={290}
        max={720}
        onChange={(rightWidth) => updatePreferences({ rightWidth })}
      />
      <PdfResearchProvider
        value={{
          pageNumber: session.pdfState?.pageNumber ?? 1,
          setPageNumber: (pageNumber) => updatePdfState({ pageNumber }),
          scrollToPage: (pageNumber) => {
            updatePdfState({ pageNumber })
            globalThis.document
              .getElementById(`pdf-page-${documentId}-${pageNumber}`)
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          },
          annotations: pdfAnnotationsQuery.data ?? [],
          annotationQuery: session.pdfAnnotationQuery ?? '',
          setAnnotationQuery: (pdfAnnotationQuery) =>
            sessions.updateSession(documentId, { pdfAnnotationQuery }),
          selectedAnnotationId: session.pdfSelectedAnnotationId ?? null,
          setSelectedAnnotationId: (pdfSelectedAnnotationId) =>
            sessions.updateSession(documentId, { pdfSelectedAnnotationId }),
          draft: session.pdfDraft ?? null,
          setDraft: (pdfDraft) => sessions.updateSession(documentId, { pdfDraft }),
        }}
      >
        <DocumentInspector
          width={preferences.rightWidth}
          document={document}
          content={content}
          selectedText={selectedText}
          onCollapse={() => updatePreferences({ rightVisible: false })}
          onUpdated={updateCachedDocument}
          onFocusEditor={() => sessions.focusEditor(documentId)}
          onScrollToLine={(line) => sessions.scrollToLine(documentId, line)}
        />
      </PdfResearchProvider>
    </>
  )
}

function TabStrip({
  groupId,
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
  const activeTab = tabs.find((tab) => tab.documentId === activeDocumentId)
  return (
    <div className="editor-tabbar" role="tablist" aria-label="Open documents">
      <div className="editor-tabs-scroll">
        {tabs.map((tab) => (
          <DocumentTab
            key={tab.documentId}
            groupId={groupId}
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
  groupId,
  tab,
  active,
  onActivate,
  onClose,
}: {
  groupId: string
  tab: WorkbenchTab
  active: boolean
  onActivate: (documentId: string) => void
  onClose: (documentId: string) => void
}) {
  const session = useDocumentSession(tab.documentId)
  const dirty = session.saveState !== 'saved'
  return (
    <div className={active ? 'editor-tab active' : 'editor-tab'} role="presentation">
      <button
        id={`editor-tab-${groupId}-${tab.documentId}`}
        role="tab"
        aria-controls={`editor-panel-${groupId}`}
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        title={tab.title}
        onClick={() => onActivate(tab.documentId)}
        onKeyDown={activateTabFromKeyboard}
      >
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
  if (documentQuery.isLoading) return <StateMessage kind="loading" title="Opening document" />
  if (documentQuery.isError || !documentQuery.data) {
    return (
      <StateMessage
        kind="error"
        title="Document could not be opened"
        description="The saved tab may refer to another workspace, or the document may have been removed."
        action={
          <div className="state-actions">
            <button type="button" onClick={() => void documentQuery.refetch()}>
              Retry
            </button>
            <button type="button" className="secondary-action" onClick={onDeleted}>
              Close stale tab
            </button>
          </div>
        }
      />
    )
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
