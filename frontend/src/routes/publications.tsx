import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Copy, ExternalLink, FileText, Globe2, KeyRound, Pencil, RefreshCw, Search, X } from 'lucide-react'
import { api, type IssuedPublication, type Publication } from '../api'
import { OneTimeSecret } from '../components/OneTimeSecret'
import { StateMessage } from '../components/ui/StateMessage'

export const Route = createFileRoute('/publications')({ component: PublicationsDashboard })

type PolicyFilter = Publication['access_policy'] | 'all'
type StatusFilter = 'all' | 'live' | 'unpublished'

function PublicationsDashboard() {
  const queryClient = useQueryClient()
  const publications = useQuery({ queryKey: ['publications'], queryFn: api.listPublications })
  const [query, setQuery] = useState('')
  const [policy, setPolicy] = useState<PolicyFilter>('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [editing, setEditing] = useState<Publication | null>(null)
  const [oneTimePublication, setOneTimePublication] = useState<IssuedPublication | null>(null)
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return (publications.data ?? []).filter((publication) => {
      if (policy !== 'all' && publication.access_policy !== policy) return false
      if (status === 'live' && !publication.active) return false
      if (status === 'unpublished' && publication.active) return false
      return (
        !normalized || `${publication.document_title} ${publication.slug}`.toLowerCase().includes(normalized)
      )
    })
  }, [policy, publications.data, query, status])
  const refresh = async () => queryClient.invalidateQueries({ queryKey: ['publications'] })
  const update = useMutation({
    mutationFn: ({
      publication,
      slug,
      accessPolicy,
    }: {
      publication: Publication
      slug: string
      accessPolicy: Publication['access_policy']
    }) => api.updatePublication(publication, slug, accessPolicy),
    onSuccess: async (result) => {
      setEditing(null)
      if (result.token) setOneTimePublication(result)
      await refresh()
    },
  })
  const unpublish = useMutation({ mutationFn: api.unpublish, onSuccess: refresh })
  const rotate = useMutation({
    mutationFn: (publicationId: string) => api.rotatePublicationToken(publicationId),
    onSuccess: async (result) => {
      setOneTimePublication(result)
      await refresh()
    },
  })

  return (
    <section className="utility-page publications-dashboard">
      <header className="utility-header">
        <div>
          <h1>Publications</h1>
          <p>See every workspace publication, its reach, and the credential state behind unlisted links.</p>
        </div>
        <Globe2 size="var(--icon-page)" />
      </header>
      <div className="publication-filters">
        <label>
          <Search size="var(--icon-control)" />
          <input
            type="search"
            aria-label="Search publications"
            placeholder="Title or slug"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <select
          aria-label="Publication access policy"
          value={policy}
          onChange={(event) => {
            const val = event.target.value
            if (val === 'all' || val === 'public' || val === 'unlisted' || val === 'private') {
              setPolicy(val)
            }
          }}
        >
          <option value="all">All policies</option>
          <option value="public">Public</option>
          <option value="unlisted">Unlisted</option>
          <option value="private">Private</option>
        </select>
        <select
          aria-label="Publication status"
          value={status}
          onChange={(event) => {
            const val = event.target.value
            if (val === 'all' || val === 'live' || val === 'unpublished') {
              setStatus(val)
            }
          }}
        >
          <option value="all">All statuses</option>
          <option value="live">Live</option>
          <option value="unpublished">Unpublished</option>
        </select>
      </div>
      {oneTimePublication?.token && (
        <OneTimeSecret
          title="Copy the new unlisted link now"
          description="The previous link was revoked. This token is shown once."
          value={`${oneTimePublication.url}#token=${oneTimePublication.token}`}
          copyLabel="Copy publication link"
          dismissLabel="I saved it"
          onDismiss={() => setOneTimePublication(null)}
        />
      )}
      <div className="publication-list" aria-live="polite">
        {filtered.map((publication) => (
          <article key={publication.publication_id} className="publication-card">
            <div className="publication-card-main">
              <div>
                <Link to="/documents/$documentId" params={{ documentId: publication.document_id }}>
                  <FileText size="var(--icon-inline)" /> {publication.document_title}
                </Link>
                <code>{publication.document_path ?? `/p/${publication.slug}`}</code>
              </div>
              <div className="publication-badges">
                <span className={`scope-badge policy-${publication.access_policy}`}>
                  {publication.access_policy}
                </span>
                <span className={`scope-badge ${publication.active ? 'publication-live' : ''}`}>
                  {publication.active ? 'Live' : 'Unpublished'}
                </span>
                {publication.access_policy === 'unlisted' && (
                  <span className="scope-badge">
                    <KeyRound size="var(--icon-inline)" />{' '}
                    {publication.has_active_token ? 'Token active' : 'No token'}
                  </span>
                )}
              </div>
              <small>Updated {new Date(publication.updated_at).toLocaleString()}</small>
            </div>
            <div className="publication-card-actions">
              <a className="secondary-action" href={publication.url} target="_blank" rel="noreferrer">
                <ExternalLink size="var(--icon-inline)" /> Open
              </a>
              <button
                className="secondary-action"
                onClick={() => void navigator.clipboard.writeText(publication.url)}
              >
                <Copy size="var(--icon-inline)" /> Copy URL
              </button>
              <button className="secondary-action" onClick={() => setEditing(publication)}>
                <Pencil size="var(--icon-inline)" /> Edit
              </button>
              {publication.active && publication.access_policy === 'unlisted' && (
                <button
                  className="secondary-action"
                  disabled={rotate.isPending}
                  onClick={() => rotate.mutate(publication.publication_id)}
                >
                  <RefreshCw size="var(--icon-inline)" /> Rotate link
                </button>
              )}
              {publication.active && (
                <button
                  className="secondary-action danger"
                  disabled={unpublish.isPending}
                  onClick={() => unpublish.mutate(publication)}
                >
                  Unpublish
                </button>
              )}
            </div>
          </article>
        ))}
        {publications.isLoading && <StateMessage compact kind="loading" title="Loading publications" />}
        {publications.isError && (
          <StateMessage
            compact
            kind="error"
            title="Publications could not be loaded"
            description={publications.error.message}
            action={<button onClick={() => void publications.refetch()}>Retry</button>}
          />
        )}
        {!publications.isLoading && filtered.length === 0 && (
          <StateMessage
            compact
            kind="empty"
            title="No matching publications"
            description="Publish a document or widen the filters."
          />
        )}
      </div>
      {editing && (
        <PublicationEditor
          publication={editing}
          pending={update.isPending}
          error={update.isError ? update.error.message : null}
          onClose={() => setEditing(null)}
          onSave={(slug, accessPolicy) => update.mutate({ publication: editing, slug, accessPolicy })}
        />
      )}
    </section>
  )
}

function PublicationEditor({
  publication,
  pending,
  error,
  onClose,
  onSave,
}: {
  publication: Publication
  pending: boolean
  error: string | null
  onClose: () => void
  onSave: (slug: string, accessPolicy: Publication['access_policy']) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [slug, setSlug] = useState(publication.slug)
  const [accessPolicy, setAccessPolicy] = useState(publication.access_policy)
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])
  return (
    <dialog
      ref={dialogRef}
      className="publication-edit-dialog"
      aria-label={`Edit ${publication.document_title}`}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClose={onClose}
    >
      <header>
        <div>
          <h2>Edit publication</h2>
          <p>{publication.document_title}</p>
        </div>
        <button className="icon-button" aria-label="Close publication editor" onClick={onClose}>
          <X size="var(--icon-control)" />
        </button>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onSave(slug, accessPolicy)
        }}
      >
        <label>
          <span>Slug</span>
          <input
            required
            pattern="[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
          />
        </label>
        <label>
          <span>Access policy</span>
          <select
            value={accessPolicy}
            onChange={(event) => {
              const val = event.target.value
              if (val === 'private' || val === 'unlisted' || val === 'public') {
                setAccessPolicy(val)
              }
            }}
          >
            <option value="private">Private</option>
            <option value="unlisted">Unlisted</option>
            <option value="public">Public</option>
          </select>
        </label>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div>
          <button disabled={pending}>{pending ? 'Saving…' : 'Save publication'}</button>
          <button type="button" className="secondary-action" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  )
}
