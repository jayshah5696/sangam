import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { api } from '../api'
import { HtmlPreview } from '../components/HtmlPreview'
import { MarkdownPreview } from '../components/MarkdownPreview'

export const Route = createFileRoute('/p/$slug')({
  validateSearch: z.object({ revision: z.string().optional() }),
  component: PublicationPage,
})

function PublicationPage() {
  const { slug } = Route.useParams()
  const { revision } = Route.useSearch()
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? undefined)
  const publication = useQuery({
    queryKey: ['publication-content', slug, revision, token],
    queryFn: () => api.getPublicationContent(slug, revision, token),
    retry: false,
  })
  const content = publication.data
  const resolveAsset = useCallback(
    (reference: string) => {
      if (!content) return Promise.reject(new Error('Publication is not ready'))
      return api.publicationAsset(content.asset_base_url, reference, token)
    },
    [content, token],
  )
  if (publication.isLoading)
    return <main className="publication-page center-message">Opening publication…</main>
  if (publication.isError || !content) {
    return (
      <main className="publication-page publication-missing">
        <p className="eyebrow">Sangam publication</p>
        <h1>Page not found</h1>
        <p>This link is unavailable, private, expired, or no longer published.</p>
      </main>
    )
  }
  return (
    <main className="publication-page">
      <header>
        <p className="eyebrow">Sangam publication</p>
        <h1>{content.title}</h1>
        <small>{content.is_latest ? 'Latest revision' : `Revision ${content.revision_id}`}</small>
      </header>
      {content.content_type === 'text/html' ? (
        <HtmlPreview content={content.content} resolveAsset={resolveAsset} />
      ) : (
        <MarkdownPreview content={content.content} resolveAsset={resolveAsset} />
      )}
    </main>
  )
}
