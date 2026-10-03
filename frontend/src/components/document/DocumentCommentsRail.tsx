import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Check, RefreshCw } from 'lucide-react'
import { api, type Document, type DocumentComment } from '../../api'
import { announceCitationNavigation, type TextLocator } from '../../citationNavigation'
import { remapEvidencePassage } from '../../evidenceCitation'
import { StateMessage } from '../ui/StateMessage'

type CommentFilter = 'open' | 'resolved' | 'all'

export function DocumentCommentsRail({ document, content }: { document: Document; content: string }) {
  const [filter, setFilter] = useState<CommentFilter>('open')
  const queryClient = useQueryClient()

  const commentsQuery = useQuery({
    queryKey: ['documents', document.document_id, 'comments'],
    queryFn: () => api.listComments(document.document_id),
  })

  const resolveMutation = useMutation({
    mutationFn: ({
      commentId,
      resolved,
      version,
    }: {
      commentId: string
      resolved: boolean
      version: number
    }) => api.resolveComment(document.document_id, commentId, resolved, version),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['documents', document.document_id, 'comments'],
      })
    },
  })

  const allComments = commentsQuery.data ?? []
  const openCount = allComments.filter((c) => !c.resolved_at).length
  const resolvedCount = allComments.filter((c) => Boolean(c.resolved_at)).length

  const filteredComments = allComments.filter((c) => {
    if (filter === 'open') return !c.resolved_at
    if (filter === 'resolved') return Boolean(c.resolved_at)
    return true
  })

  return (
    <section className="document-comments-rail" aria-label="Document comments">
      <header className="comments-rail-header">
        <div className="comments-rail-title">
          <p className="eyebrow">Discussions</p>
          <strong>Passage comments</strong>
        </div>
        <div className="comments-rail-filters" role="tablist" aria-label="Filter comments">
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'open'}
            className={`comments-filter-tab ${filter === 'open' ? 'active' : ''}`}
            onClick={() => setFilter('open')}
          >
            Open ({openCount})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'resolved'}
            className={`comments-filter-tab ${filter === 'resolved' ? 'active' : ''}`}
            onClick={() => setFilter('resolved')}
          >
            Resolved ({resolvedCount})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'all'}
            className={`comments-filter-tab ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All ({allComments.length})
          </button>
        </div>
      </header>

      {commentsQuery.isLoading ? (
        <p className="small-muted">Loading comments…</p>
      ) : commentsQuery.isError ? (
        <StateMessage
          compact
          kind="error"
          title="Could not load comments"
          description={
            commentsQuery.error instanceof Error ? commentsQuery.error.message : String(commentsQuery.error)
          }
        />
      ) : filteredComments.length === 0 ? (
        <StateMessage
          compact
          kind="empty"
          title={
            allComments.length === 0
              ? 'No comments yet'
              : filter === 'open'
                ? 'All comments resolved'
                : 'No comments in this view'
          }
          description={
            allComments.length === 0
              ? 'Select any text passage in the document and click Comment to anchor feedback.'
              : undefined
          }
        />
      ) : (
        <div className="comments-list" role="feed" aria-label="Document comments list">
          {filteredComments.map((comment) => (
            <CommentCard
              key={comment.comment_id}
              comment={comment}
              document={document}
              content={content}
              onResolve={(resolved) =>
                resolveMutation.mutate({
                  commentId: comment.comment_id,
                  resolved,
                  version: comment.version,
                })
              }
              isResolving={resolveMutation.isPending}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function CommentCard({
  comment,
  document,
  content,
  onResolve,
  isResolving,
}: {
  comment: DocumentComment
  document: Document
  content: string
  onResolve: (resolved: boolean) => void
  isResolving: boolean
}) {
  const isCurrent = comment.revision_id === document.current_revision_id
  const originalLocator: TextLocator = {
    exact: comment.exact,
    prefix: comment.prefix,
    suffix: comment.suffix,
    start: comment.start,
    end: comment.end,
  }

  let effectiveLocator: TextLocator | undefined = originalLocator
  let isDetached = false

  if (!isCurrent) {
    const remapped = remapEvidencePassage(content, {
      sourceContentType: document.content_type,
      selectedText: comment.exact,
      textLocator: originalLocator,
    })
    if (remapped) {
      effectiveLocator = remapped
    } else {
      isDetached = true
      effectiveLocator = undefined
    }
  }

  const handleJump = () => {
    if (isDetached || !effectiveLocator) return
    announceCitationNavigation({
      documentId: document.document_id,
      revisionId: isCurrent ? comment.revision_id : undefined,
      textLocator: effectiveLocator,
    })
  }

  return (
    <article
      className={`comment-card ${comment.resolved_at ? 'resolved' : ''} ${isDetached ? 'detached' : ''}`}
      aria-label={`Comment by ${comment.created_by}`}
    >
      <header className="comment-card-header">
        <div className="comment-card-meta">
          <span className="comment-card-author">{comment.created_by}</span>
          <time dateTime={comment.created_at} className="small-muted">
            {new Date(comment.created_at).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        </div>
        <div className="comment-card-badges">
          {comment.resolved_at ? (
            <span className="scope-badge scope-badge-resolved">Resolved</span>
          ) : isDetached ? (
            <span
              className="scope-badge scope-badge-detached"
              title="Passage was modified in subsequent edits"
            >
              <AlertCircle size="var(--icon-inline)" /> Detached
            </span>
          ) : (
            <span className="scope-badge scope-badge-anchored">Anchored</span>
          )}
        </div>
      </header>

      <blockquote
        className={`comment-card-quote ${isDetached ? 'detached' : 'interactive'}`}
        onClick={handleJump}
        title={isDetached ? 'Original passage was modified' : 'Jump to passage in editor'}
      >
        <p>{comment.exact}</p>
      </blockquote>

      <p className="comment-card-body">{comment.body}</p>

      <footer className="comment-card-actions">
        {comment.resolved_at ? (
          <button
            type="button"
            className="secondary-action button-sm"
            disabled={isResolving}
            onClick={() => onResolve(false)}
          >
            <RefreshCw size="var(--icon-inline)" /> Reopen
          </button>
        ) : (
          <button
            type="button"
            className="secondary-action button-sm"
            disabled={isResolving}
            onClick={() => onResolve(true)}
          >
            <Check size="var(--icon-inline)" /> Resolve
          </button>
        )}
      </footer>
    </article>
  )
}
