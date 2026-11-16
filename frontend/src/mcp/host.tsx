import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge'
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { StateMessage } from '../components/ui/StateMessage'
import {
  errorSchema,
  programHitsSchema,
  resourceSchema,
  workspaceSchema,
  type PresentArguments,
  type Workspace,
} from './contracts'
import '../styles.css'
import '../styles/mcp-workspace.css'

const APP_URI = 'ui://sangam/document-workspace.html'

function McpHost() {
  const [key, setKey] = useState('')
  const [connected, setConnected] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ReturnType<typeof programHitsSchema.parse>['output']['items']>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [trace, setTrace] = useState<string[]>([])
  const client = useRef<Client | null>(null)
  const bridge = useRef<AppBridge | null>(null)
  const mount = useRef<HTMLDivElement | null>(null)
  const opened = useRef<{ layoutId: string } | null>(null)

  function rememberWorkspace(workspace: Workspace) {
    opened.current = { layoutId: workspace.layout.layout_id }
    const url = new URL(location.href)
    url.searchParams.set('document', workspace.document.document_id)
    url.searchParams.set('workspace', workspace.workspace_id)
    url.searchParams.set('layout', workspace.layout.layout_id)
    history.replaceState(null, '', url)
  }

  async function run(operation: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await operation()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The MCP request failed.')
    } finally {
      setBusy(false)
    }
  }

  async function connect() {
    const apiKey = key
    const next = new Client(
      { name: 'Sangam local MCP host', version: '0.1.0' },
      {
        capabilities: { extensions: { 'io.modelcontextprotocol/ui': {} } },
      },
    )
    await next.connect(
      new StreamableHTTPClientTransport(new URL('/mcp/', location.origin), {
        authProvider: { token: async () => apiKey },
      }),
    )
    await next.listTools()
    client.current = next
    setConnected(true)
    setKey('')
    setTrace(['Connected to the real /mcp endpoint. Discovered public tools.'])
    const params = new URL(location.href).searchParams
    const documentId = params.get('document')
    const workspaceId = params.get('workspace')
    const layoutId = params.get('layout')
    if (layoutId) await open({ layout_id: layoutId })
    else if (documentId && workspaceId) await open({ document_id: documentId, workspace_id: workspaceId })
  }

  async function search() {
    const connection = client.current
    if (!connection) return
    const discovery = await connection.callTool({
      name: 'search',
      arguments: { query: 'documents.search documents.read' },
    })
    if (discovery.isError) throw new Error('Operation discovery failed.')
    const code = `await documents_search(query=${JSON.stringify(query)}, limit=10)`
    const reply = await connection.callTool({
      name: 'execute',
      arguments: { code, execution_key: crypto.randomUUID() },
    })
    if (reply.isError) {
      const parsed = errorSchema.safeParse(reply.structuredContent)
      throw new Error(parsed.success ? parsed.data.error.message : 'Document search failed.')
    }
    setHits(programHitsSchema.parse(reply.structuredContent).output.items)
    setTrace((previous) => [
      ...previous,
      'search → discovered documents.search',
      `execute → fresh Monty Python: ${code}`,
    ])
  }

  async function open(args: PresentArguments) {
    const connection = client.current
    const container = mount.current
    if (!connection || !container) return
    if (bridge.current) await bridge.current.teardownResource({})
    const reply = await connection.callTool({ name: 'present', arguments: args })
    if (reply.isError) {
      const parsed = errorSchema.safeParse(reply.structuredContent)
      throw new Error(parsed.success ? parsed.data.error.message : 'The workspace could not be opened.')
    }
    const workspace = workspaceSchema.parse(reply.structuredContent)
    const resources = resourceSchema.parse(await connection.readResource({ uri: APP_URI }))
    const html = resources.contents[0]?.text
    if (!html) throw new Error('The server did not return its App HTML.')
    container.replaceChildren()
    const iframe = document.createElement('iframe')
    iframe.title = 'Sangam document workspace'
    iframe.sandbox.add('allow-scripts')
    container.append(iframe)
    const target = iframe.contentWindow
    if (!target) throw new Error('The App frame could not be created.')
    const next = new AppBridge(
      null,
      { name: 'Sangam local MCP host', version: '0.1.0' },
      { serverTools: {} },
      { hostContext: { theme: 'light', displayMode: 'inline' } },
    )
    next.oncalltool = async (params) => {
      if (params.name !== 'mcp_app') throw new Error('This App can call only its typed interaction tool.')
      const result = await connection.callTool(params)
      if (!result.isError) {
        const current = workspaceSchema.safeParse(result.structuredContent)
        if (current.success) rememberWorkspace(current.data)
      }
      setTrace((previous) => [
        ...previous.slice(-19),
        'App bridge → mcp_app → current grants → shared document services',
      ])
      return result
    }
    next.oninitialized = async () => {
      await next.sendToolResult(reply)
    }
    await next.connect(new PostMessageTransport(target, target))
    bridge.current = next
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'">`
    iframe.srcdoc = html.replace('<head>', `<head>${csp}`)
    rememberWorkspace(workspace)
    setTrace((previous) => [
      ...previous,
      'present → fetched ui:// HTML → standard AppBridge → sandboxed iframe',
    ])
  }

  return (
    <main className="mcp-host">
      <header className="mcp-host-header">
        <a href="/">Sangam</a>
        <span>MCP local host</span>
        <p>Find a document. Edit it in the App. Verify the saved revision.</p>
      </header>
      {!connected ? (
        <form
          className="mcp-connect"
          onSubmit={(event) => {
            event.preventDefault()
            void run(connect)
          }}
        >
          <h1>Connect to this Sangam instance</h1>
          <p>
            Use an existing key with read, search, and update permissions. The key stays in host memory and
            never enters the App.
          </p>
          <label>
            Sangam API key
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              required
            />
          </label>
          <button className="primary-button" disabled={busy} type="submit">
            Connect
          </button>
        </form>
      ) : (
        <>
          <section className="mcp-host-tools">
            <div>
              <span className="scope-badge">Connected with existing permissions</span>
              <form
                className="mcp-search"
                onSubmit={(event) => {
                  event.preventDefault()
                  void run(search)
                }}
              >
                <label>
                  Find a document
                  <input value={query} onChange={(event) => setQuery(event.target.value)} required />
                </label>
                <button className="primary-button" disabled={busy} type="submit">
                  Search documents
                </button>
              </form>
            </div>
            <button
              className="secondary-action"
              disabled={busy || !opened.current}
              onClick={() => {
                const state = opened.current
                if (state) void run(() => open({ layout_id: state.layoutId }))
              }}
            >
              Reopen App
            </button>
          </section>
          {hits.length > 0 && (
            <ul className="mcp-results">
              {hits.map((hit) => (
                <li key={hit.document_id}>
                  <button
                    className="secondary-action"
                    disabled={busy}
                    onClick={() => {
                      void run(() => open({ document_id: hit.document_id }))
                    }}
                    aria-label={`Open ${hit.title}`}
                  >
                    {hit.title}
                    <span>{hit.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {error && <StateMessage kind="error" title="Connection or action failed" description={error} />}
      <div ref={mount} className="mcp-app-mount" />
      {connected && (
        <details className="mcp-trace">
          <summary>Connection and tool trace</summary>
          <ol>
            {trace.map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ol>
          <p>
            This page is a local MCP host. No model response is simulated; document search runs the displayed
            Python through the server's Monty worker.
          </p>
        </details>
      )}
    </main>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('MCP host root is missing')
createRoot(root).render(<McpHost />)
