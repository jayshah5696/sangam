import { lazy, Suspense } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { MessageSquareText } from 'lucide-react'

const ChatPanel = lazy(() =>
  import('../components/ChatPanel').then((module) => ({ default: module.ChatPanel })),
)

export const Route = createFileRoute('/chat')({ component: WorkspaceChat })

function WorkspaceChat() {
  return (
    <section className="workspace-chat-page">
      <header className="utility-header">
        <div>
          <p className="eyebrow">Whole workspace</p>
          <h1>Workspace chat</h1>
          <p>Search, compare, and create across your notes without opening a document first.</p>
        </div>
        <MessageSquareText size={28} />
      </header>
      <div className="workspace-chat-surface">
        <Suspense fallback={<div className="center-message">Preparing workspace chat…</div>}>
          <ChatPanel />
        </Suspense>
      </div>
    </section>
  )
}
