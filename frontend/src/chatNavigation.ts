const SELECTION_LIMIT = 20_000

export type ChatNavigationContext = {
  selectedText?: string
  pdfPageNumber?: number
  annotationId?: string
}

declare module '@tanstack/history' {
  interface HistoryState {
    sangamChatContext?: ChatNavigationContext
  }
}

export function chatNavigationState(
  selectedText: string,
  pdfContext?: { pageNumber?: number | null; annotationId?: string | null },
) {
  const bounded = selectedText.slice(0, SELECTION_LIMIT)
  const context: ChatNavigationContext = {}
  if (bounded) context.selectedText = bounded
  if (pdfContext?.pageNumber && pdfContext.pageNumber > 0) context.pdfPageNumber = pdfContext.pageNumber
  if (pdfContext?.annotationId) context.annotationId = pdfContext.annotationId
  return Object.keys(context).length > 0 ? { sangamChatContext: context } : {}
}
