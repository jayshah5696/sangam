import type { DocumentSummary } from './api'
import type { WorkbenchTab } from './workbench'

export type HomeDocumentSections<T> = { pinned: T[]; recent: T[] }

export function selectHomeDocuments<T extends Pick<DocumentSummary, 'document_id'>>(
  documents: T[],
  tabs: WorkbenchTab[],
): HomeDocumentSections<T> {
  const byId = new Map(documents.map((document) => [document.document_id, document]))
  const seen = new Set<string>()
  const pinned: T[] = []
  const recent: T[] = []
  for (const tab of tabs) {
    const document = byId.get(tab.documentId)
    if (!document || seen.has(document.document_id)) continue
    seen.add(document.document_id)
    if (tab.pinned) pinned.push(document)
    else recent.push(document)
  }
  return { pinned, recent }
}
