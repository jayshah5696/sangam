import type { Publication } from './api'

export type PublicationStatus =
  | { kind: 'private' }
  | { kind: 'current'; publication: Publication }
  | { kind: 'behind'; publication: Publication; publishedRevisionId: string; draftRevisionId: string }

/**
 * Compare what readers see with the saved draft. `draftRevisionId` is the
 * document's current head from the editor's cache, which moves on every save,
 * so it is fresher than the head recorded when the publication was fetched.
 */
export function publicationStatus(
  publication: Publication | null | undefined,
  draftRevisionId: string,
): PublicationStatus {
  if (!publication?.active) return { kind: 'private' }
  if (publication.revision_id === draftRevisionId) return { kind: 'current', publication }
  return {
    kind: 'behind',
    publication,
    publishedRevisionId: publication.revision_id,
    draftRevisionId,
  }
}
