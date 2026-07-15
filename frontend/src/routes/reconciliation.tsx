import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { api, type ReconciliationConflict } from '../api'

export const Route = createFileRoute('/reconciliation')({ component: ReconciliationPage })

function ReconciliationPage() {
  const queryClient = useQueryClient()
  const report = useQuery({ queryKey: ['reconciliation'], queryFn: api.reconciliation })
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['reconciliation'] }),
      queryClient.invalidateQueries({ queryKey: ['documents'] }),
      queryClient.invalidateQueries({ queryKey: ['folders'] }),
    ])
  }
  const scan = useMutation({ mutationFn: api.scanWorkspace, onSuccess: refresh })
  return (
    <section className="utility-page">
      <header className="utility-header">
        <div>
          <p className="eyebrow">Workspace integrity</p>
          <h1>Reconciliation</h1>
          <p>
            Review disk changes explicitly. Sangam never guesses when the database and workspace disagree.
          </p>
        </div>
        <button className="primary-button" onClick={() => scan.mutate()} disabled={scan.isPending}>
          {scan.isPending ? 'Scanning…' : 'Scan workspace'}
        </button>
      </header>
      {report.isLoading && <p className="muted">Checking conflicts…</p>}
      {report.isError && <p className="error-text">Reconciliation status could not be loaded.</p>}
      {report.data?.conflicts.length === 0 && (
        <div className="empty-state">
          <strong>Workspace is in sync.</strong>
          <p>No unresolved disk changes need a decision.</p>
        </div>
      )}
      <div className="conflict-list">
        {report.data?.conflicts.map((conflict) => (
          <ConflictCard key={conflict.conflict_id} conflict={conflict} onResolved={refresh} />
        ))}
      </div>
    </section>
  )
}

function ConflictCard({
  conflict,
  onResolved,
}: {
  conflict: ReconciliationConflict
  onResolved: () => Promise<void>
}) {
  const resolve = useMutation({
    mutationFn: async (choice: string) => {
      if (choice === 'accept-disk') return api.acceptDisk(conflict.conflict_id)
      if (choice === 'restore-database') return api.restoreDatabase(conflict.conflict_id)
      if (choice === 'recognize-move') return api.recognizeMove(conflict.conflict_id)
      if (choice === 'import') return api.importUnknown(conflict.path)
      return api.ignoreUnknown(conflict.conflict_id)
    },
    onSuccess: onResolved,
  })
  return (
    <article className="conflict-card">
      <div>
        <span className={`conflict-kind ${conflict.conflict_type}`}>{label(conflict.conflict_type)}</span>
        <time>{new Date(conflict.created_at).toLocaleString()}</time>
      </div>
      <h2>{conflict.path}</h2>
      {conflict.candidate_path && (
        <p>
          Possible new path: <code>{conflict.candidate_path}</code>
        </p>
      )}
      <p>{description(conflict.conflict_type)}</p>
      {conflict.document_id && (
        <Link to="/documents/$documentId" params={{ documentId: conflict.document_id }}>
          Open database document
        </Link>
      )}
      <div className="conflict-actions">
        {conflict.conflict_type === 'unexpected_hash' && (
          <>
            <button onClick={() => resolve.mutate('accept-disk')}>Import disk as revision</button>
            <button onClick={() => resolve.mutate('restore-database')}>Restore database version</button>
          </>
        )}
        {conflict.conflict_type === 'possible_move' && conflict.candidate_path && (
          <button onClick={() => resolve.mutate('recognize-move')}>Recognize move</button>
        )}
        {conflict.conflict_type === 'unknown_file' && (
          <>
            <button onClick={() => resolve.mutate('import')}>Import as document</button>
            <button onClick={() => resolve.mutate('ignore')}>Ignore unchanged file</button>
          </>
        )}
      </div>
      {resolve.isPending && <p className="muted">Applying decision…</p>}
      {resolve.isError && (
        <p className="error-text">That decision could not be applied. The conflict remains open.</p>
      )}
    </article>
  )
}

function label(type: ReconciliationConflict['conflict_type']) {
  return { unexpected_hash: 'External edit', possible_move: 'Possible move', unknown_file: 'Unknown file' }[
    type
  ]
}

function description(type: ReconciliationConflict['conflict_type']) {
  return {
    unexpected_hash: 'The materialized file changed outside Sangam. Choose which content becomes canonical.',
    possible_move:
      'A file with the expected content appeared at another path. Confirm the move to preserve stable identity.',
    unknown_file: 'This Markdown file is not registered. Import it explicitly or ignore this exact version.',
  }[type]
}
