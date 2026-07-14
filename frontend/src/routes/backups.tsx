import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { api, type BackupSet } from '../api'

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
        <div><p className="eyebrow">Operational recovery</p><h1>Backups</h1><p>Each set contains an online SQLite snapshot, a workspace archive, checksums, and a verification result. Sangam creates one nightly and retains the newest 14 sets by default.</p></div>
        <button className="primary-button" disabled={create.isPending} onClick={() => create.mutate()}>{create.isPending ? 'Creating and verifying…' : 'Back up now'}</button>
      </header>
      {backups.data?.length === 0 && <div className="empty-state"><strong>No backup sets yet.</strong><p>Create one now or leave Sangam running for the nightly schedule.</p></div>}
      <div className="backup-list">{backups.data?.map((backup) => <BackupCard key={backup.backup_id} backup={backup} />)}</div>
      {backups.isError && <p className="error-text">Backup inventory could not be loaded.</p>}
    </section>
  )
}

function BackupCard({ backup }: { backup: BackupSet }) {
  const queryClient = useQueryClient()
  const verify = useMutation({
    mutationFn: () => api.verifyBackup(backup.backup_id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backups'] }),
  })
  return (
    <article className="backup-card">
      <div><div><span className={backup.verified_at ? 'verification verified' : 'verification'}>{backup.verified_at ? 'Verified' : 'Unverified'}</span><h2>{new Date(backup.created_at).toLocaleString()}</h2></div><button disabled={verify.isPending} onClick={() => verify.mutate()}>{verify.isPending ? 'Verifying…' : 'Verify again'}</button></div>
      <p>{backup.document_count} documents · {backup.revision_count} revisions</p>
      <ul>{backup.artifacts.map((artifact) => <li key={artifact.name}><code>{artifact.name}</code><span>{formatBytes(artifact.size_bytes)}</span><small title={artifact.sha256}>SHA-256 {artifact.sha256.slice(0, 16)}…</small></li>)}</ul>
      {verify.data && <p className="success-text">SQLite integrity: {verify.data.database_integrity} · {verify.data.workspace_members} archive entries</p>}
      {verify.isError && <p className="error-text">Verification failed. Do not rely on this backup set.</p>}
    </article>
  )
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}
