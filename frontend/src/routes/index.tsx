import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Welcome })

function Welcome() {
  return (
    <section className="welcome">
      <p className="eyebrow">Your workspace</p>
      <h1>Files with memory.</h1>
      <p>Create Markdown documents, group them into folders, organize them with categories and tags, and find them again through full-text search.</p>
    </section>
  )
}
