import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { FileText } from 'lucide-react'
import { z } from 'zod'
import { api } from '../api'
import { HtmlPreview } from '../components/HtmlPreview'
import { MarkdownPreview } from '../components/MarkdownPreview'
import { PublicationEvidenceDrawer } from '../components/publication/PublicationEvidenceDrawer'
import { TrustedHtmlPreview } from '../components/TrustedHtmlPreview'

export const Route = createFileRoute('/p/$slug')({
  validateSearch: z.object({ revision: z.string().optional() }),
  component: PublicationPage,
})

function PublicationPage() {
  const { slug } = Route.useParams()
  const { revision } = Route.useSearch()
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? undefined)
  const [evidenceDrawerOpen, setEvidenceDrawerOpen] = useState(false)

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

  const handleHighlightPassage = useCallback((text: string) => {
    if (!text.trim()) return
    const container = document.querySelector('.publication-article-container')
    if (!container) return
    const elements = container.querySelectorAll('p, li, blockquote, h1, h2, h3, h4, h5, h6')
    const target = text.trim().toLowerCase().slice(0, 40)
    for (const el of elements) {
      if (el.textContent && el.textContent.toLowerCase().includes(target)) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.classList.add('evidence-highlight-pulse')
        setTimeout(() => el.classList.remove('evidence-highlight-pulse'), 3000)
        return
      }
    }
  }, [])

  if (publication.isLoading)
    return <main className="publication-page center-message">Opening publication…</main>
  if (publication.isError || !content) {
    return (
      <main className="publication-page publication-missing">
        <h1>Page not found</h1>
        <p>This link is unavailable, private, expired, or no longer published.</p>
      </main>
    )
  }
  const isHtml = content.content_type === 'text/html'
  const hasEvidence = Boolean(content.evidence && content.evidence.length > 0)
  const evidenceCount = content.evidence?.length ?? 0

  return (
    <main className={`publication-page ${isHtml ? 'html-publication-page' : ''}`}>
      <header>
        <div className="publication-header-text">
          <h1>{content.title}</h1>
          <small>{content.is_latest ? 'Latest revision' : `Revision ${content.revision_id}`}</small>
        </div>
        {hasEvidence && (
          <button
            type="button"
            className={`evidence-drawer-toggle ${evidenceDrawerOpen ? 'active' : ''}`}
            onClick={() => setEvidenceDrawerOpen((prev) => !prev)}
            aria-expanded={evidenceDrawerOpen}
            aria-controls="publication-evidence-drawer"
            aria-label={`Evidence drawer (${evidenceCount})`}
          >
            <FileText size="var(--icon-inline)" aria-hidden="true" />
            <span>Evidence</span>
            <span className="evidence-badge">{evidenceCount}</span>
          </button>
        )}
      </header>

      <div className={`publication-content-layout ${evidenceDrawerOpen && hasEvidence ? 'with-drawer' : ''}`}>
        <div className="publication-article-container">
          {isHtml ? (
            content.javascript_enabled && content.interactive_preview ? (
              <TrustedHtmlPreview
                revisionId={content.revision_id}
                grant={content.interactive_preview}
                title="Interactive HTML publication"
              />
            ) : (
              <HtmlPreview content={content.content} resolveAsset={resolveAsset} />
            )
          ) : (
            <MarkdownPreview content={content.content} resolveAsset={resolveAsset} />
          )}
        </div>

        {hasEvidence && (
          <PublicationEvidenceDrawer
            evidence={content.evidence}
            isOpen={evidenceDrawerOpen}
            onClose={() => setEvidenceDrawerOpen(false)}
            onHighlightPassage={handleHighlightPassage}
          />
        )}
      </div>
    </main>
  )
}
