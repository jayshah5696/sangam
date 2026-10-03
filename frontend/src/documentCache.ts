import type { QueryClient } from '@tanstack/react-query'
import type { Document } from './api'

/**
 * Make every cached view of a document follow a new server head: the document
 * itself, the lists and folder counts that summarize it, and its history.
 * Call it for any write that returns a Document; the session store calls it for
 * every head it saves or adopts.
 */
export function adoptDocumentInCache(queryClient: QueryClient, document: Document) {
  queryClient.setQueryData(['document', document.document_id], document)
  void queryClient.invalidateQueries({ queryKey: ['documents'] })
  void queryClient.invalidateQueries({ queryKey: ['history', document.document_id] })
  void queryClient.invalidateQueries({ queryKey: ['folders'] })
}
