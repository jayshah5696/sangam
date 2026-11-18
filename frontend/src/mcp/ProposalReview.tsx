import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { App } from '@modelcontextprotocol/ext-apps'
import { RevisionComparison } from '../components/RevisionMergeView'
import { StateMessage } from '../components/ui/StateMessage'
import {
  proposalMetadataSchema,
  proposalPageSchema,
  proposalPassageSchema,
  revisionPassageSchema,
  type ProposalAction,
  type ProposalMutationAction,
  type Workspace,
} from './contracts'
import { z } from 'zod'
import { AppActionError as ReviewError, callAppTool } from './tool-client'

type Proposal = z.infer<typeof proposalPassageSchema>
type ProposalPage = z.infer<typeof proposalPageSchema>

export function ProposalReview({
  app,
  workspace,
  active,
  initialContent,
  dirtyDocument,
  onApplied,
  onClose,
  onUnsavedChange,
  initialProposalId,
}: {
  app: App
  workspace: Workspace
  active: boolean
  initialContent: string
  dirtyDocument: boolean
  onApplied: () => Promise<void>
  onClose: () => void
  onUnsavedChange: (dirty: boolean) => void
  initialProposalId?: string | null
}) {
  const [page, setPage] = useState<ProposalPage | null>(null)
  const [selected, setSelected] = useState<Proposal | null>(null)
  const [original, setOriginal] = useState('')
  const [reviewed, setReviewed] = useState('')
  const [creating, setCreating] = useState(false)
  const [summary, setSummary] = useState('')
  const [proposedContent, setProposedContent] = useState('')
  const [creationBase, setCreationBase] = useState(workspace.document.current_revision_id)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState<ProposalMutationAction | null>(null)
  const [changed, setChanged] = useState(false)
  const [dark, setDark] = useState(() => getComputedStyle(document.documentElement).colorScheme === 'dark')
  const generation = useRef(0)
  const localDirty =
    attempt !== null ||
    (creating && (summary !== '' || proposedContent !== initialContent)) ||
    (selected !== null && reviewed !== selected.content) ||
    reason !== ''

  useEffect(() => {
    onUnsavedChange(localDirty)
  }, [localDirty, onUnsavedChange])
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(getComputedStyle(document.documentElement).colorScheme === 'dark'),
    )
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  async function request(action: ProposalAction) {
    return callAppTool(app, action)
  }

  async function run(operation: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await operation()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Proposal action failed.')
    } finally {
      setBusy(false)
    }
  }

  async function list(offset = 0) {
    const next = proposalPageSchema.parse(
      await request({ type: 'proposal_list', workspace_id: workspace.workspace_id, offset, limit: 10 }),
    )
    setPage((previous) => ({
      items: offset === 0 ? next.items : [...(previous?.items ?? []), ...next.items],
      next_offset: next.next_offset,
    }))
  }

  const readSnapshot = useEffectEvent(async () => {
    if (!active || busy) return null
    const observedGeneration = generation.current
    const nextPage = proposalPageSchema.parse(
      await request({ type: 'proposal_list', workspace_id: workspace.workspace_id, offset: 0, limit: 10 }),
    )
    let changed = false
    if (selected) {
      const current = proposalPassageSchema.parse(
        await request({
          type: 'proposal_read',
          workspace_id: workspace.workspace_id,
          proposal_id: selected.proposal_id,
          offset: 0,
          length: 1,
        }),
      )
      changed =
        current.status !== selected.status || current.applied_revision_id !== selected.applied_revision_id
    }
    return { page: nextPage, changed, generation: observedGeneration }
  })
  const openInitialProposal = useEffectEvent(() => {
    if (initialProposalId && selected?.proposal_id !== initialProposalId)
      void run(() => load(initialProposalId))
  })
  useEffect(() => {
    let cancelled = false
    void readSnapshot()
      .then((snapshot) => {
        if (cancelled || !snapshot || generation.current !== snapshot.generation) return
        setPage(snapshot.page)
        if (snapshot.changed) setChanged(true)
        openInitialProposal()
      })
      .catch((failure) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : 'Proposal refresh failed.')
      })
    return () => {
      cancelled = true
    }
  }, [active, workspace.proposal_version, initialProposalId])

  async function load(proposalId: string, contentKind: 'proposed' | 'applied' = 'proposed') {
    const currentGeneration = ++generation.current
    let offset = 0
    let content = ''
    let proposal: Proposal
    do {
      proposal = proposalPassageSchema.parse(
        await request({
          type: 'proposal_read',
          workspace_id: workspace.workspace_id,
          proposal_id: proposalId,
          offset,
          length: 32000,
          content_kind: contentKind,
          include_evidence: true,
        }),
      )
      content += proposal.content
      if (proposal.next_offset === null) break
      if (proposal.next_offset <= offset) throw new Error('The proposal passage did not advance.')
      offset = proposal.next_offset
    } while (proposal.next_offset !== null)
    if (proposal.status === 'applied' && contentKind !== 'applied') {
      await load(proposalId, 'applied')
      return
    }
    let base = ''
    offset = 0
    while (true) {
      const part = revisionPassageSchema.parse(
        await request({
          type: 'revision_read',
          workspace_id: workspace.workspace_id,
          document_id: workspace.document.document_id,
          revision_id: proposal.expected_revision_id,
          offset,
          length: 32000,
        }),
      )
      if (part.revision_id !== proposal.expected_revision_id)
        throw new Error('The review base revision changed.')
      base += part.content
      if (part.next_offset === null) break
      if (part.next_offset <= offset) throw new Error('The revision passage did not advance.')
      offset = part.next_offset
    }
    if (generation.current !== currentGeneration) return
    setSelected({ ...proposal, content })
    setOriginal(base)
    setReviewed(content)
    setReason('')
    setCreating(false)
    setChanged(false)
  }

  async function mutate(action: ProposalMutationAction) {
    setAttempt(action)
    try {
      const outcome = proposalMetadataSchema.parse(await request(action))
      await load(outcome.proposal_id, action.type === 'proposal_apply' ? 'applied' : 'proposed')
      await list()
      if (action.type === 'proposal_apply') await onApplied()
      setAttempt(null)
    } catch (failure) {
      // Only server-confirmed rejection permits correction. Ambiguous outcomes retain exact arguments.
      if (failure instanceof ReviewError && failure.outcome === 'rejected') setAttempt(null)
      throw failure
    }
  }

  function newProposal() {
    generation.current += 1
    setSelected(null)
    setCreating(true)
    setSummary('')
    setProposedContent(initialContent)
    setCreationBase(workspace.document.current_revision_id)
    setError('')
    setReason('')
    setChanged(false)
  }
  const stale = selected !== null && selected.expected_revision_id !== workspace.document.current_revision_id
  const editable = selected?.status === 'pending' && !stale && !changed && workspace.can_update

  return (
    <section className="mcp-proposal-review" aria-label="Proposal review" hidden={!active}>
      <header className="mcp-review-toolbar">
        <h2>Proposals</h2>
        <div className="mcp-controls">
          <button
            className="secondary-action"
            disabled={busy || localDirty || !workspace.can_update}
            onClick={newProposal}
          >
            New proposal
          </button>
          <button className="secondary-action" disabled={busy} onClick={() => void run(() => list())}>
            Refresh proposals
          </button>
          <button className="secondary-action" disabled={busy || localDirty} onClick={onClose}>
            Close review
          </button>
        </div>
      </header>
      {error && <StateMessage compact kind="error" title="Proposal action failed" description={error} />}
      {attempt && (
        <button className="secondary-action" disabled={busy} onClick={() => void run(() => mutate(attempt))}>
          {attempt.type === 'proposal_apply'
            ? 'Retry apply'
            : attempt.type === 'proposal_create'
              ? 'Retry creation'
              : 'Retry dismissal'}
        </button>
      )}
      <div className="mcp-review-body">
        <nav className="mcp-review-list" aria-label="Document proposals">
          {!page && <StateMessage compact kind="loading" title="Loading proposals" />}
          {page?.items.length === 0 && <StateMessage compact kind="empty" title="No proposals" />}
          {page?.items.map((proposal) => (
            <button
              className="secondary-action"
              key={proposal.proposal_id}
              disabled={busy || localDirty}
              aria-current={selected?.proposal_id === proposal.proposal_id ? 'true' : undefined}
              onClick={() =>
                void run(() =>
                  load(proposal.proposal_id, proposal.status === 'applied' ? 'applied' : 'proposed'),
                )
              }
            >
              <span>{proposal.summary ?? 'Proposal'}</span>
              <span className="scope-badge">{proposal.status}</span>
            </button>
          ))}
          {page?.next_offset !== null && page?.next_offset !== undefined && (
            <button
              className="secondary-action"
              disabled={busy}
              onClick={() => void run(() => list(page.next_offset ?? 0))}
            >
              More proposals
            </button>
          )}
        </nav>
        <div className="mcp-review-content">
          {creating ? (
            <div role="form" aria-label="New proposal">
              <label className="mcp-review-field">
                Proposal summary
                <input
                  value={summary}
                  maxLength={500}
                  required
                  disabled={busy || attempt !== null}
                  onChange={(event) => setSummary(event.target.value)}
                />
              </label>
              <label className="mcp-review-field">
                Proposed content
                <textarea
                  aria-label="Proposed content"
                  value={proposedContent}
                  disabled={busy || attempt !== null}
                  onChange={(event) => setProposedContent(event.target.value)}
                />
              </label>
              <button
                className="primary-button"
                disabled={busy || attempt !== null || !workspace.can_update || !summary.trim()}
                type="button"
                onClick={() =>
                  void run(() =>
                    mutate({
                      type: 'proposal_create',
                      workspace_id: workspace.workspace_id,
                      document_id: workspace.document.document_id,
                      expected_revision_id: creationBase,
                      summary,
                      content: proposedContent,
                      operation_key: crypto.randomUUID(),
                    }),
                  )
                }
              >
                Create proposal
              </button>
              <button
                className="secondary-action"
                disabled={busy || attempt !== null}
                type="button"
                onClick={() => {
                  setCreating(false)
                  setSummary('')
                  setProposedContent('')
                }}
              >
                Discard review edits
              </button>
            </div>
          ) : selected ? (
            <>
              <h3>{selected.summary ?? 'Proposal'}</h3>
              <div className="mcp-review-reference">Base revision {selected.expected_revision_id}</div>
              {changed && (
                <StateMessage
                  compact
                  kind="error"
                  title="Proposal changed while you were reviewing"
                  description="Your review edits are preserved. Reload the proposal to read its recorded wording."
                  action={
                    <button
                      className="secondary-action"
                      disabled={busy || attempt !== null}
                      onClick={() => void run(() => load(selected.proposal_id))}
                    >
                      {localDirty ? 'Discard review edits and reload' : 'Reload proposal'}
                    </button>
                  }
                />
              )}
              {selected.status === 'applied' && (
                <StateMessage
                  compact
                  kind="success"
                  title="Proposal applied"
                  description={`Saved revision ${selected.applied_revision_id}`}
                />
              )}
              {selected.status === 'dismissed' && (
                <StateMessage compact kind="empty" title="Proposal dismissed" />
              )}
              {selected.rationale && <p>{selected.rationale}</p>}
              {stale && selected.status !== 'applied' && (
                <StateMessage
                  compact
                  kind="error"
                  title="Document changed"
                  description="This proposal uses an older revision. Create a new proposal against the current document."
                />
              )}
              {dirtyDocument && selected.status === 'pending' && (
                <StateMessage
                  compact
                  kind="error"
                  title="Document draft is open"
                  description="Save or discard your document draft before applying a proposal."
                />
              )}
              <RevisionComparison original={original} modified={reviewed} mode={dark ? 'dark' : 'light'} />
              {(selected.status === 'pending' || reviewed !== selected.content) && (
                <label className="mcp-review-field">
                  Reviewed wording
                  <textarea
                    aria-label="Reviewed wording"
                    value={reviewed}
                    disabled={busy || attempt !== null || !editable}
                    onChange={(event) => setReviewed(event.target.value)}
                  />
                </label>
              )}
              <details>
                <summary>Evidence</summary>
                {selected.evidence && (
                  <blockquote>
                    {selected.evidence.selected_text}
                    <p>
                      Revision {selected.evidence.revision_id}
                      {selected.evidence.pdf_page_number ? `, page ${selected.evidence.pdf_page_number}` : ''}
                    </p>
                  </blockquote>
                )}
                {selected.evidence_status === 'not_recorded' && <p>No source evidence was recorded.</p>}
                {selected.evidence_status === 'unavailable' && <p>Some source evidence is unavailable.</p>}
                {selected.citations?.map((citation, index) => (
                  <blockquote key={`${citation.document_id}-${index}`}>
                    {citation.available ? citation.snippet : 'Source unavailable'}
                  </blockquote>
                ))}
                {selected.sources_retrieved?.map((source, index) => (
                  <p key={`${source.document_id}-${index}`}>
                    {source.title} {source.path}
                  </p>
                ))}
                {selected.sources_retrieved_truncated && (
                  <p>Some retrieved source references were omitted.</p>
                )}
              </details>
              {(selected.status === 'pending' || selected.status === 'stale') && (
                <>
                  <label className="mcp-review-field">
                    Dismissal reason
                    <input
                      value={reason}
                      maxLength={500}
                      disabled={busy || attempt !== null || changed}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </label>
                  <div className="mcp-controls">
                    <button
                      className="primary-button"
                      disabled={busy || attempt !== null || !editable || dirtyDocument}
                      onClick={() =>
                        void run(() =>
                          mutate({
                            type: 'proposal_apply',
                            workspace_id: workspace.workspace_id,
                            proposal_id: selected.proposal_id,
                            expected_revision_id: selected.expected_revision_id,
                            content: reviewed,
                            operation_key: crypto.randomUUID(),
                          }),
                        )
                      }
                    >
                      Apply proposal
                    </button>
                    <button
                      className="secondary-action"
                      disabled={busy || attempt !== null}
                      onClick={() =>
                        void run(() =>
                          mutate({
                            type: 'proposal_dismiss',
                            workspace_id: workspace.workspace_id,
                            proposal_id: selected.proposal_id,
                            reason,
                            operation_key: crypto.randomUUID(),
                          }),
                        )
                      }
                    >
                      Dismiss proposal
                    </button>
                  </div>
                </>
              )}
            </>
          ) : (
            <StateMessage compact kind="empty" title="Select a proposal" />
          )}
          {selected && localDirty && !attempt && !creating && (
            <button
              className="secondary-action"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  load(selected.proposal_id, selected.status === 'applied' ? 'applied' : 'proposed'),
                )
              }
            >
              Discard review edits
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
