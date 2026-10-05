// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchView } from './WorkbenchView'
import type { LayoutNode } from '../../workbench'

const state = vi.hoisted(() => {
  // SAFETY: test workbench layout fixture
  const root = {
    kind: 'split',
    id: 'split-1',
    direction: 'horizontal',
    ratio: 0.5,
    first: {
      kind: 'group',
      id: 'group-1',
      activeTabId: 'doc-1',
      tabs: [{ documentId: 'doc-1', title: 'Doc 1', pinned: false }],
    },
    second: {
      kind: 'group',
      id: 'group-2',
      activeTabId: 'doc-2',
      tabs: [{ documentId: 'doc-2', title: 'Doc 2', pinned: false }],
    },
  } as LayoutNode
  return {
    root,
    activeGroupId: 'group-1',
    isMobile: false,
    preferences: {
      rightVisible: false,
      rightWidth: 320,
      rightTab: 'properties',
      theme: 'river',
      contrast: 'normal',
      density: 'comfortable',
      fontSize: 14,
      leftVisible: true,
      leftWidth: 260,
      editorLayout: 'stacked',
      editorFontSize: 14,
    },
  }
})

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock('react-resizable-panels', () => ({
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: () => <div />,
  PanelResizeHandle: () => <div />,
}))

vi.mock('../document/DocumentWorkspace', () => ({
  DocumentWorkspace: () => <div data-testid="document-workspace" />,
}))

vi.mock('../../useMediaQuery', () => ({
  useMediaQuery: (query: string) => (query.includes('max-width: 768px') ? state.isMobile : false),
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: {
      document_id: 'doc-1',
      title: 'Doc 1',
      content: 'hello',
      content_type: 'text/markdown',
      current_revision_id: 'rev-1',
      metadata_version: 1,
    },
    isLoading: false,
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
    getQueryData: vi.fn(() => ({
      document_id: 'doc-1',
      title: 'Doc 1',
      content: 'hello',
      content_type: 'text/markdown',
    })),
  }),
  keepPreviousData: <T,>(v: T) => v,
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}))

vi.mock('../../workbench', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workbench')>()
  return {
    ...actual,
    useWorkbench: () => ({
      root: state.root,
      activeGroupId: state.activeGroupId,
      recentlyClosed: [],
      activateTab: vi.fn(),
      closeTab: vi.fn(),
      closeGroup: vi.fn(),
      closeOtherTabs: vi.fn(),
      togglePinned: vi.fn(),
      reopenClosedTab: vi.fn(),
      splitGroup: vi.fn(),
      setActiveGroup: vi.fn(),
      resetLayout: vi.fn(),
      ensureDocumentOpen: vi.fn(),
    }),
    useWorkbenchActions: () => ({
      updateDocumentTitle: vi.fn(),
      ensureDocumentOpen: vi.fn(),
    }),
  }
})

vi.mock('../../theme', () => ({
  useTheme: () => ({
    preferences: state.preferences,
    updatePreferences: vi.fn(),
  }),
}))

vi.mock('../../documentSessions', () => ({
  useDocumentSessions: () => ({
    acceptServerDocument: vi.fn(),
    focusEditor: vi.fn(),
    scrollToLine: vi.fn(),
    updateSession: vi.fn(),
  }),
  useDocumentSession: () => ({
    content: 'hello',
    saveState: 'saved',
    viewState: null,
    selection: { line: 1, column: 1, selectedCharacters: 0 },
    mode: 'edit',
    draftPersistenceState: 'clean',
  }),
}))

vi.mock('../../api', () => ({
  api: {
    getDocument: vi.fn(async (id: string) => ({
      document_id: id,
      title: 'Doc',
      content: 'hello',
      content_type: 'text/markdown',
      current_revision_id: 'rev-1',
    })),
  },
}))

afterEach(cleanup)

describe('WorkbenchView - Issue #62 & #74', () => {
  it('renders tab strips with close controls when multiple split groups exist, even with 1 tab each', () => {
    render(<WorkbenchView routeDocumentId="doc-1" />)
    const tabBars = screen.getAllByRole('tablist', { name: 'Open documents' })
    expect(tabBars.length).toBe(2)
  })

  it('renders direct tab triggers in collapsed right rail', () => {
    state.root = {
      kind: 'group',
      id: 'group-1',
      activeTabId: 'doc-1',
      tabs: [{ documentId: 'doc-1', title: 'Doc 1', pinned: false }],
    }
    state.preferences.rightVisible = false
    render(<WorkbenchView routeDocumentId="doc-1" />)
    expect(screen.getByLabelText('Document properties')).toBeDefined()
    expect(screen.getByLabelText('Document outline')).toBeDefined()
    expect(screen.getByLabelText('Revision history')).toBeDefined()
    expect(screen.getByLabelText('Ask about this document')).toBeDefined()
  })

  it('exposes persistent workspace layout presets', () => {
    render(<WorkbenchView routeDocumentId="doc-1" />)
    expect(screen.getByRole('button', { name: 'Workspace layouts' })).toBeDefined()
  })

  it('scrolls active tab into view', () => {
    const scrollIntoViewMock = vi.fn()
    window.HTMLElement.prototype.scrollIntoView = scrollIntoViewMock
    state.root = {
      kind: 'group',
      id: 'group-1',
      activeTabId: 'doc-1',
      tabs: [
        { documentId: 'doc-1', title: 'Doc 1', pinned: false },
        { documentId: 'doc-2', title: 'Doc 2', pinned: false },
      ],
    }
    render(<WorkbenchView routeDocumentId="doc-1" />)
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
  })

  it('renders single working surface switcher on mobile when multiple groups exist', () => {
    state.isMobile = true
    state.root = {
      kind: 'split',
      id: 'split-1',
      direction: 'horizontal',
      ratio: 50,
      first: {
        kind: 'group',
        id: 'group-1',
        activeTabId: 'doc-1',
        tabs: [{ documentId: 'doc-1', title: 'Draft Doc', pinned: false }],
      },
      second: {
        kind: 'group',
        id: 'group-2',
        activeTabId: 'doc-2',
        tabs: [{ documentId: 'doc-2', title: 'Source PDF', pinned: false }],
      },
    }
    render(<WorkbenchView routeDocumentId="doc-1" />)
    expect(screen.getByRole('tablist', { name: 'Working surfaces' })).toBeDefined()
    const surfaceTabs = screen.getAllByRole('tab')
    expect(surfaceTabs.length).toBe(2)
    expect(surfaceTabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(surfaceTabs[1]?.getAttribute('aria-selected')).toBe('false')
  })
})
