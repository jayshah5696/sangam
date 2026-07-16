import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
import { useDocumentSession } from '../documentSessions'
import { findGroup, useWorkbench } from '../workbench'

export function StatusBar() {
  const workbench = useWorkbench()
  const activeGroup = findGroup(workbench.root, workbench.activeGroupId)
  const documentId = activeGroup?.activeTabId
  const session = useDocumentSession(documentId ?? null)
  const documentQuery = useQuery({
    queryKey: ['document', documentId],
    queryFn: () => api.getDocument(documentId!),
    enabled: Boolean(documentId),
  })
  const reconciliation = useQuery({
    queryKey: ['reconciliation', 'status'],
    queryFn: api.reconciliation,
    staleTime: 30_000,
  })
  const state = session?.saveState ?? 'ready'
  const selection = session?.selection
  return (
    <footer className={`workbench-status ${state}`} aria-label="Workspace status">
      <div>
        <span className="status-dot" /> <strong>{statusLabel(state)}</strong>
        {documentQuery.data && <span>{documentQuery.data.updated_by_name}</span>}
      </div>
      <div>
        {(reconciliation.data?.conflicts.length ?? 0) > 0 && (
          <span>{reconciliation.data!.conflicts.length} conflicts</span>
        )}
        {selection && (
          <span>
            Ln {selection.line}, Col {selection.column}
            {selection.selectedCharacters ? ` · ${selection.selectedCharacters} selected` : ''}
          </span>
        )}
        <span>Markdown</span>
      </div>
    </footer>
  )
}

function statusLabel(state: string) {
  return (
    {
      ready: 'Ready',
      saved: 'Saved',
      dirty: 'Unsaved',
      saving: 'Saving…',
      conflict: 'Conflict',
      failed: 'Save failed',
      offline: 'Offline',
    }[state] ?? state
  )
}
