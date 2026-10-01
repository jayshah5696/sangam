/**
 * Whether an image reference points into the workspace and must be resolved
 * through the API: the shared `/attachments/` folder or a path relative to the
 * document. URLs, other root paths, and fragments load as written.
 */
export function isWorkspaceAssetReference(reference: string): boolean {
  if (!reference) return false
  if (reference.startsWith('/attachments/')) return true
  return !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(reference)
}
