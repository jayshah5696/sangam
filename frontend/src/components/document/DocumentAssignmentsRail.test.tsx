// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Assignment } from '../../api'
import { DocumentAssignmentsRail } from './DocumentAssignmentsRail'
import { api } from '../../api'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}))

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      listDocumentAssignments: vi.fn(),
      createDocumentAssignment: vi.fn(),
      controlAssignment: vi.fn(),
    },
  }
})

describe('DocumentAssignmentsRail', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    })
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  const mockAssignment: Assignment = {
    assignment_id: 'assign-123',
    project_id: null,
    thread_id: 'thread-123',
    status: 'running',
    instructions: 'Choose an embedding model',
    document_ids: ['doc-target'],
    max_steps: 3,
    max_seconds: 180,
    steps: 1,
    elapsed_seconds: 45,
    input_tokens: 1200,
    output_tokens: 340,
    artifact_ids: [],
    proposal_ids: [],
    current_finding: 'The smaller model fits the memory budget. Long-document quality is still uncertain.',
    working_on: 'Checking long-document retrieval',
    needs_judgment: 'Is a 5% quality drop acceptable for twice the speed?',
    produced_artifacts: ['comparison.md', 'benchmark-results.csv'],
    child_assignments: [],
    max_budget_cents: 500,
    consumed_budget_cents: 120,
    error: null,
    created_at: '2026-10-06T10:00:00Z',
    updated_at: '2026-10-06T10:00:45Z',
  }

  it('renders workspace agent rail header and empty message when no assignments', async () => {
    vi.mocked(api.listDocumentAssignments).mockResolvedValue([])

    render(
      <QueryClientProvider client={queryClient}>
        <DocumentAssignmentsRail documentId="doc-target" />
      </QueryClientProvider>,
    )

    expect(screen.getByText('Workspace Agent')).toBeDefined()
    expect(screen.getByText('Check claims')).toBeDefined()
  })

  it('toggles start form when Check claims is clicked', async () => {
    vi.mocked(api.listDocumentAssignments).mockResolvedValue([])

    render(
      <QueryClientProvider client={queryClient}>
        <DocumentAssignmentsRail documentId="doc-target" />
      </QueryClientProvider>,
    )

    const checkClaimsBtn = screen.getByText('Check claims')
    fireEvent.click(checkClaimsBtn)

    expect(screen.getByText('Run review')).toBeDefined()
    expect(screen.getByText('Cancel')).toBeDefined()

    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByText('Run review')).toBeNull()
  })

  it('renders active assignment with current finding, working on, and judgment prompt', async () => {
    vi.mocked(api.listDocumentAssignments).mockResolvedValue([mockAssignment])

    render(
      <QueryClientProvider client={queryClient}>
        <DocumentAssignmentsRail documentId="doc-target" />
      </QueryClientProvider>,
    )

    expect(await screen.findByText('Choose an embedding model')).toBeDefined()
    expect(screen.getByText('Running')).toBeDefined()
    expect(screen.getByText('Current finding')).toBeDefined()
    expect(
      screen.getByText('The smaller model fits the memory budget. Long-document quality is still uncertain.'),
    ).toBeDefined()
    expect(screen.getByText('Working on')).toBeDefined()
    expect(screen.getByText('Checking long-document retrieval')).toBeDefined()
    expect(screen.getByText('Needs your judgment')).toBeDefined()
    expect(screen.getByText('Is a 5% quality drop acceptable for twice the speed?')).toBeDefined()
    expect(screen.getByText('comparison.md')).toBeDefined()
    expect(screen.getByText('benchmark-results.csv')).toBeDefined()
    expect(screen.getByText('Pause')).toBeDefined()
    expect(screen.getByText('Steer')).toBeDefined()
    expect(screen.getByText('Stop')).toBeDefined()
  })
})
