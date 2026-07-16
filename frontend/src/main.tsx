import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { IndexedDbDraftStorage } from './browserState/draftStorage'
import { migrateLegacyDrafts } from './browserState/legacyDraftMigration'
import { routeTree } from './routeTree.gen'
import { ThemeProvider } from './theme'
import { DocumentSessionsProvider } from './documentSessions'
import { WorkbenchProvider } from './workbench'
import './styles.css'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})
const router = createRouter({ routeTree, context: { queryClient } })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('Sangam root element is missing')
const reactRoot = createRoot(root)

async function bootstrap() {
  const draftStorage = new IndexedDbDraftStorage()
  try {
    await migrateLegacyDrafts(draftStorage)
  } catch (error) {
    console.error('Sangam could not safely migrate legacy browser drafts.', error)
    reactRoot.render(
      <main className="welcome" role="alert">
        <p className="eyebrow">Local draft recovery paused</p>
        <h1>Your drafts are still safe.</h1>
        <p>Sangam could not move older browser drafts into protected storage. No draft data was removed.</p>
        <button className="primary-button" onClick={() => window.location.reload()}>
          Try again
        </button>
      </main>,
    )
    return
  }

  reactRoot.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <WorkbenchProvider>
            <DocumentSessionsProvider storage={draftStorage}>
              <RouterProvider router={router} />
            </DocumentSessionsProvider>
          </WorkbenchProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>,
  )
}

void bootstrap()
