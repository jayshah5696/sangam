const SELECTION_LIMIT = 20_000

export type ChatNavigationContext = {
  selectedText?: string
}

declare module '@tanstack/history' {
  interface HistoryState {
    sangamChatContext?: ChatNavigationContext
  }
}

export function chatNavigationState(selectedText: string) {
  const bounded = selectedText.slice(0, SELECTION_LIMIT)
  return bounded ? { sangamChatContext: { selectedText: bounded } } : {}
}
