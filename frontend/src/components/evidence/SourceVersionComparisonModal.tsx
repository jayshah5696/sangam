import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, HelpCircle, X } from 'lucide-react'
import { api } from '../../api'
import type { EvidenceItem } from '../../evidenceCitation'
import type { TextLocator } from '../../citationNavigation'
import { remapEvidencePassage } from '../../evidenceCitation'
import { analyzePassageRecheck, shortRevision } from '../../evidenceDependencies'
import { MarkdownPreview } from '../MarkdownPreview'
import { ModalDialog } from '../ui/ModalDialog'
import { StateMessage } from '../ui/StateMessage'
import { SelectableHtmlText } from '../SelectableHtmlText'

export interface SourceComparisonTarget {
  id: string
  sourceDocumentId: string
  sourceTitle: string
  sourceContentType?: 'text/markdown' | 'text/html' | 'application/pdf'
  pinnedRevisionId?: string
  pageNumber?: number
  selectedText?: string | null
  claim?: string | null | null
  note?: string | null
  textLocator?: TextLocator
  sourceCurrentRevisionId?: string
  sourceSupersededByTitle?: string
  evidenceItem?: EvidenceItem
}

interface SourceVersionComparisonModalProps {
  item: SourceComparisonTarget
  onClose: () => void
  onUpdateRevision?: (newRevisionId: string, content: string) => Promise<void>
  onReviseConclusion?: () => void
  requirePassageRemap?: boolean
}

export function SourceVersionComparisonModal({
  item,
  onClose,
  onUpdateRevision,
  onReviseConclusion,
  requirePassageRemap = false,
}: SourceVersionComparisonModalProps) {
  const [error, setError] = useState<string | null>(null)
  const [isUpdating, setIsUpdating] = useState(false)

  const historyQuery = useQuery({
    queryKey: ['revision', item.sourceDocumentId, item.pinnedRevisionId],
    queryFn: () => api.revision(item.sourceDocumentId, item.pinnedRevisionId ?? ''),
    enabled: Boolean(item.pinnedRevisionId),
  })

  const docQuery = useQuery({
    queryKey: ['document', item.sourceDocumentId],
    queryFn: () => api.getDocument(item.sourceDocumentId),
  })

  const pinnedRev = historyQuery.data
  const currentDoc = docQuery.data
  const currentRevId = currentDoc?.current_revision_id || item.sourceCurrentRevisionId
  // SAFETY: content_type from API document is restricted to text/markdown, text/html, or application/pdf.
  const contentType =
    item.sourceContentType ||
    (currentDoc?.content_type as 'text/markdown' | 'text/html' | 'application/pdf') ||
    'text/markdown'

  const remapped = useMemo(() => {
    if (!currentDoc || !item.selectedText) return undefined
    return remapEvidencePassage(currentDoc.content, {
      sourceContentType: contentType,
      selectedText: item.selectedText,
      textLocator: item.textLocator,
    })
  }, [currentDoc, item.selectedText, item.textLocator, contentType])

  const analysis = useMemo(() => {
    if (!item.selectedText || !currentDoc?.content) return null
    return analyzePassageRecheck(item.selectedText, currentDoc.content, contentType, item.textLocator)
  }, [currentDoc, item.selectedText, item.textLocator, contentType])

  const handleUpdate = async () => {
    if (!currentRevId || !currentDoc || !onUpdateRevision) return
    setIsUpdating(true)
    setError(null)
    try {
      await onUpdateRevision(currentRevId, currentDoc.content)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsUpdating(false)
    }
  }

  return (
    <ModalDialog className="evidence-modal-dialog wide" ariaLabel="Compare source versions" onClose={onClose}>
      <div className="evidence-modal-content wide">
        <header className="evidence-modal-header">
          <div>
            <strong>Compare source versions: {item.sourceTitle}</strong>
            <p className="small-muted">
              Pinned: {shortRevision(item.pinnedRevisionId)} &middot; Current head:{' '}
              {shortRevision(currentRevId)}
            </p>
          </div>
          <button type="button" className="icon-button-sm" onClick={onClose} aria-label="Close comparison">
            <X size="var(--icon-control)" />
          </button>
        </header>

        {item.claim && (
          <div className="evidence-modal-claim-banner">
            <span className="evidence-meta-label">Associated Conclusion / Claim:</span>
            <strong className="dependent-conclusion-claim">{item.claim}</strong>
          </div>
        )}

        <div className="evidence-modal-suggestion-box">
          <HelpCircle size="var(--icon-control)" style={{ flexShrink: 0 }} />
          <div>
            <p style={{ margin: 0, fontWeight: 500 }}>
              {analysis?.suggestion || 'Recheck your claim against the new revision content.'}
            </p>
            <p className="small-muted" style={{ margin: 'var(--space-1) 0 0 0' }}>
              Detecting a newer source revision is deterministic. Deciding whether the change invalidates a
              claim requires judgment and remains a suggestion.
            </p>
          </div>
        </div>

        {item.selectedText && (
          <div style={{ padding: 'var(--space-2) var(--space-3)', borderBottom: '1px solid var(--line)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 'var(--space-1)',
              }}
            >
              <span className="evidence-meta-label">Original Pinned Excerpt:</span>
              {analysis && (
                <span className={`recheck-status-badge ${analysis.status}`}>
                  {analysis.status === 'identical' && <CheckCircle2 size="12" />}
                  {analysis.status === 'modified' && <AlertTriangle size="12" />}
                  {analysis.status === 'removed' && <AlertTriangle size="12" />}
                  {analysis.summary}
                </span>
              )}
            </div>
            <blockquote className="evidence-card-quote">
              <p>{item.selectedText}</p>
            </blockquote>
          </div>
        )}

        {item.sourceSupersededByTitle && (
          <div className="evidence-source-changed-alert" style={{ margin: 'var(--space-3)' }}>
            <AlertTriangle size="var(--icon-control)" />
            <div>
              <strong>Source paper superseded</strong>
              <p>This paper was replaced by "{item.sourceSupersededByTitle}".</p>
            </div>
          </div>
        )}

        <div className="evidence-version-comparison-body">
          <div className="evidence-version-column">
            <h4>Pinned revision ({shortRevision(item.pinnedRevisionId)})</h4>
            <div className="comparison-preview-container">
              {pinnedRev ? (
                contentType === 'text/html' ? (
                  <SelectableHtmlText content={pinnedRev.content} initiallyOpen />
                ) : (
                  <MarkdownPreview content={pinnedRev.content} />
                )
              ) : (
                <StateMessage
                  compact
                  kind={historyQuery.isError || historyQuery.isSuccess ? 'error' : 'loading'}
                  title={
                    historyQuery.isError || historyQuery.isSuccess
                      ? 'Pinned revision snapshot is unavailable'
                      : 'Loading pinned revision snapshot'
                  }
                />
              )}
            </div>
          </div>
          <div className="evidence-version-column">
            <h4>Current head revision ({shortRevision(currentRevId)})</h4>
            <div className="comparison-preview-container">
              {currentDoc ? (
                contentType === 'text/html' ? (
                  <SelectableHtmlText content={currentDoc.content} initiallyOpen />
                ) : (
                  <MarkdownPreview content={currentDoc.content} />
                )
              ) : (
                <StateMessage
                  compact
                  kind={docQuery.isError ? 'error' : 'loading'}
                  title={docQuery.isError ? 'Current source could not be loaded' : 'Loading current source'}
                />
              )}
            </div>
          </div>
        </div>

        <footer className="evidence-modal-footer">
          {error && (
            <StateMessage
              compact
              kind="error"
              title="Evidence revision could not be replaced"
              description={error}
            />
          )}
          {currentDoc && item.selectedText && !remapped && (
            <StateMessage
              compact
              kind="empty"
              title="The original passage cannot be located exactly in the current revision"
              description="Keep the original pin, or update to link your claim to the new revision."
            />
          )}
          {onReviseConclusion && (
            <button
              type="button"
              className="secondary-action"
              onClick={() => {
                onClose()
                onReviseConclusion()
              }}
            >
              Revise conclusion
            </button>
          )}
          <button type="button" className="secondary-action" onClick={onClose}>
            Keep original pinned reference
          </button>
          {currentRevId && onUpdateRevision && (
            <button
              type="button"
              className="panel-button"
              disabled={
                !currentDoc ||
                (requirePassageRemap && (!remapped || !pinnedRev)) ||
                contentType === 'application/pdf' ||
                isUpdating
              }
              onClick={() => void handleUpdate()}
            >
              {isUpdating ? 'Updating...' : 'Update to current head revision'}
            </button>
          )}
        </footer>
      </div>
    </ModalDialog>
  )
}
