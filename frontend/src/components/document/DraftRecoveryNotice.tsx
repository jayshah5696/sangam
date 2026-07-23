import { useState } from 'react'
import type { DraftPersistenceOperation, DraftPersistenceState } from '../../documentSessions'

export function offlineRecoveryMessage(state: DraftPersistenceState) {
  return state === 'persisted'
    ? 'You are offline. A recovery copy is stored in this browser; Sangam will save after reconnecting.'
    : 'You are offline. Browser recovery is not yet confirmed. Keep this tab open or export a recovery copy.'
}

export function recoveryFilename(title: string, contentType: string) {
  const stem = title
    .replace(/\.(?:html?|md|markdown|txt)$/i, '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
  const extension = contentType === 'text/html' ? 'html' : 'md'
  return `${stem || 'sangam-draft'}.recovery.${extension}`
}

export function downloadRecoveryFile(content: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function DraftRecoveryNotice({
  title,
  contentType,
  content,
  operation,
  error,
  retrying,
  onRetry,
}: {
  title: string
  contentType: string
  content: string
  operation?: DraftPersistenceOperation
  error?: string
  retrying: boolean
  onRetry: () => void
}) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const staleCopy = operation === 'delete'

  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopyStatus('copied')
    } catch {
      setCopyStatus('failed')
    }
  }

  return (
    <div className="notice error-notice draft-recovery-notice" role="alert">
      <div className="draft-recovery-copy">
        <strong>
          {staleCopy ? 'Browser recovery cleanup failed' : 'Browser draft recovery is unavailable'}
        </strong>
        <span>
          {staleCopy
            ? 'The server copy is saved, but Sangam could not remove an older browser recovery copy.'
            : 'Sangam could not confirm a recovery copy in this browser. Closing this tab could lose changes that have not reached the server.'}
        </span>
        {error && <small>{error}</small>}
        {copyStatus === 'copied' && <small role="status">Draft copied to the clipboard.</small>}
        {copyStatus === 'failed' && (
          <small role="status">Clipboard access failed. Download the recovery file instead.</small>
        )}
      </div>
      <div className="draft-recovery-actions">
        <button type="button" disabled={retrying} onClick={onRetry}>
          {retrying ? 'Retrying…' : 'Retry browser storage'}
        </button>
        <button type="button" onClick={() => void copyDraft()}>
          Copy draft
        </button>
        <button
          type="button"
          onClick={() => downloadRecoveryFile(content, recoveryFilename(title, contentType))}
        >
          Download recovery file
        </button>
      </div>
    </div>
  )
}
