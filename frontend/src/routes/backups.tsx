import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'
import { api, type BackupSet } from '../api'
import { StateMessage } from '../components/ui/StateMessage'

export const Route = createFileRoute('/backups')({ component: BackupsPage })

function BackupsPage() {
  const queryClient = useQueryClient()
  const backups = useQuery({ queryKey: ['backups'], queryFn: api.listBackups })
  const create = useMutation({
    mutationFn: api.createBackup,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backups'] }),
  })
  return (
    <section className="utility-page">
      <header className="utility-header">
        <div>
          <h1>Backups</h1>
          <p>
            Each set contains an online SQLite snapshot, a workspace archive, checksums, and a verification
            result. Sangam creates one nightly and retains the newest 14 sets by default.
          </p>
        </div>
        <button className="primary-button" disabled={create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Creating and verifying…' : 'Back up now'}
        </button>
      </header>
      {backups.isLoading && <StateMessage kind="loading" title="Loading backup inventory" />}
      {backups.data?.length === 0 && (
        <StateMessage
          kind="empty"
          title="No backup sets yet"
          description="Create a verified set now or leave Sangam running for the nightly schedule."
          action={
            <button className="primary-button" disabled={create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? 'Creating and verifying…' : 'Back up now'}
            </button>
          }
        />
      )}
      <div className="backup-list">
        {backups.data?.map((backup) => (
          <BackupCard key={backup.backup_id} backup={backup} />
        ))}
      </div>
      {backups.isError && (
        <StateMessage
          kind="error"
          title="Backup inventory could not be loaded"
          description="No backup status has been inferred from stale data."
          action={<button onClick={() => void backups.refetch()}>Retry</button>}
        />
      )}
    </section>
  )
}

function BackupCard({ backup }: { backup: BackupSet }) {
  const queryClient = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const verify = useMutation({
    mutationFn: () => api.verifyBackup(backup.backup_id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backups'] }),
  })
  const remove = useMutation({
    mutationFn: () => api.deleteBackup(backup.backup_id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backups'] }),
  })
  const deleting = confirmDelete || remove.isPending || remove.isError
  return (
    <article className="backup-card">
      <div>
        <div>
          <span className={backup.verified_at ? 'verification verified' : 'verification'}>
            {backup.verified_at ? 'Verified' : 'Unverified'}
          </span>
          <h2>{new Date(backup.created_at).toLocaleString()}</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button disabled={verify.isPending} onClick={() => verify.mutate()}>
            {verify.isPending ? 'Verifying…' : 'Verify again'}
          </button>
          {!deleting ? (
            <button
              className="danger-button secondary-action backup-delete-trigger"
              onClick={() => setConfirmDelete(true)}
              title="Delete this backup set"
            >
              <Trash2 size="var(--icon-inline)" /> Delete
            </button>
          ) : (
            <div className="backup-delete-confirm" role="group" aria-label="Confirm backup deletion">
              <button className="danger-button" disabled={remove.isPending} onClick={() => remove.mutate()}>
                {remove.isPending ? 'Deleting…' : remove.isError ? 'Retry delete' : 'Confirm delete'}
              </button>
              <button
                disabled={remove.isPending}
                onClick={() => {
                  remove.reset()
                  setConfirmDelete(false)
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
      <p>
        {backup.document_count} documents · {backup.revision_count} revisions
      </p>
      <ul>
        {backup.artifacts.map((artifact) => (
          <li key={artifact.name}>
            <code>{artifact.name}</code>
            <span>{formatBytes(artifact.size_bytes)}</span>
            <small title={artifact.sha256}>SHA-256 {artifact.sha256.slice(0, 16)}…</small>
          </li>
        ))}
      </ul>
      {verify.data && (
        <p className="success-text">
          SQLite integrity: {verify.data.database_integrity} · {verify.data.workspace_members} archive entries
        </p>
      )}
      {verify.isError && <p className="error-text">Verification failed. Do not rely on this backup set.</p>}
      {remove.isError && <p className="error-text">Backup deletion failed. The set was not removed.</p>}
    </article>
  )
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}
