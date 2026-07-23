import { useState } from 'react'
import type { Document } from '../../api'
import { RevisionMergeView } from '../RevisionMergeView'
import { downloadRecoveryFile, recoveryFilename } from './DraftRecoveryNotice'

export function ConflictRecoveryNotice({
  document,
  localContent,
  baseRevisionId,
  serverHead,
  loading,
  error,
  retrying,
  onRefresh,
  onRebaseAndRetry,
  onDiscard,
}: {
  document: Document
  localContent: string
  baseRevisionId?: string
  serverHead?: Document
  loading: boolean
  error: boolean
  retrying: boolean
  onRefresh: () => void
  onRebaseAndRetry: () => void
  onDiscard: () => void
}) {
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')

  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(localContent)
      setCopyStatus('copied')
    } catch {
      setCopyStatus('failed')
    }
  }

  return (
    <section
      className="notice conflict-notice conflict-recovery"
      role="alert"
      aria-labelledby="conflict-title"
    >
      <div className="conflict-recovery-copy">
        <strong id="conflict-title">Save conflict · local draft preserved</strong>
        <span>
          The server changed after your editing base. Review both versions before choosing what becomes the
          next revision.
        </span>
        <dl className="conflict-metadata">
          <div>
            <dt>Editing base</dt>
            <dd>{shortId(baseRevisionId) ?? 'Unknown'}</dd>
          </div>
          <div>
            <dt>Server head</dt>
            <dd>{loading ? 'Loading…' : (shortId(serverHead?.current_revision_id) ?? 'Unavailable')}</dd>
          </div>
          <div>
            <dt>Local draft</dt>
            <dd>{localContent.length.toLocaleString()} characters</dd>
          </div>
          {serverHead && (
            <div>
              <dt>Server updated</dt>
              <dd>{new Date(serverHead.updated_at).toLocaleString()}</dd>
            </div>
          )}
        </dl>
        {serverHead && (
          <details className="conflict-comparison">
            <summary>Compare server head with local draft</summary>
            <p className="small-muted">
              Server head is the original; your preserved local draft is modified.
            </p>
            <RevisionMergeView original={serverHead.content} modified={localContent} />
          </details>
        )}
        {error && (
          <p className="error-text">
            Sangam could not load the latest server head. Your local draft is unchanged; retry before rebasing
            or discarding.
          </p>
        )}
        {copyStatus === 'copied' && <small role="status">Local draft copied.</small>}
        {copyStatus === 'failed' && (
          <small role="status">Clipboard access failed. Download the recovery file instead.</small>
        )}
        {confirmDiscard && (
          <div
            className="conflict-discard-confirmation"
            role="group"
            aria-label="Confirm local draft discard"
          >
            <strong>Discard this local draft?</strong>
            <span>
              The server head will replace the editor. Export first if you may need this text later.
            </span>
            <div className="conflict-actions">
              <button type="button" className="danger-button" onClick={onDiscard}>
                Discard draft and reload
              </button>
              <button type="button" onClick={() => setConfirmDiscard(false)}>
                Keep local draft
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="conflict-actions">
        {error && (
          <button type="button" disabled={loading} onClick={onRefresh}>
            Retry loading server head
          </button>
        )}
        <button type="button" onClick={() => void copyDraft()}>
          Copy local draft
        </button>
        <button
          type="button"
          onClick={() =>
            downloadRecoveryFile(localContent, recoveryFilename(document.title, document.content_type))
          }
        >
          Download local draft
        </button>
        <button type="button" disabled={!serverHead || loading || retrying} onClick={onRebaseAndRetry}>
          {retrying ? 'Retrying…' : 'Use local draft as next revision'}
        </button>
        {!confirmDiscard && (
          <button
            type="button"
            className="danger-button"
            disabled={!serverHead || loading}
            onClick={() => setConfirmDiscard(true)}
          >
            Discard local draft…
          </button>
        )}
      </div>
    </section>
  )
}

function shortId(value?: string) {
  return value && value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
}
