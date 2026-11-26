import { useState, type FormEvent } from 'react'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Cable } from 'lucide-react'
import { z } from 'zod'
import { api } from '../api'
import { StateMessage } from './ui/StateMessage'

export const mcpSettingsQuery = queryOptions({ queryKey: ['mcp-settings'], queryFn: api.getMcpSettings })

export function mcpSetup() {
  const url = new URL('/mcp/', window.location.origin)
  const instructions = [
    'Connect to Sangam using Streamable HTTP.',
    `MCP server URL: ${url.href}`,
    "Store the Sangam agent token in your client's secret store and send it as Authorization: Bearer <token>.",
    'Call search to discover Sangam operations and their permission requirements.',
    "Use skills.list and skills.get through execute to find and load the workspace's registered instructions.",
  ].join('\n')
  return { url, instructions }
}

const catalogSchema = z.object({
  operations: z.array(z.object({ operation_id: z.string() })),
})

async function checkMcpConnection(url: URL, token: string) {
  const { Client, StreamableHTTPClientTransport, UnauthorizedError } =
    await import('@modelcontextprotocol/client')
  const client = new Client(
    { name: 'Sangam connection check', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  )
  const options = { signal: AbortSignal.timeout(8000) }
  try {
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        authProvider: { token: async () => token },
        requestInit: { redirect: 'error' },
      }),
      options,
    )
    const reply = await client.callTool(
      { name: 'search', arguments: { query: 'documents.search', limit: 1 } },
      options,
    )
    const catalog = catalogSchema.safeParse(reply.structuredContent)
    return !reply.isError &&
      catalog.success &&
      catalog.data.operations.some((operation) => operation.operation_id === 'documents.search')
      ? 'connected'
      : 'unavailable'
  } catch (error) {
    return error instanceof UnauthorizedError ? 'rejected' : 'unavailable'
  } finally {
    await client.close()
  }
}

export function McpAccessSettings() {
  const config = useQuery(mcpSettingsQuery)
  const [check, setCheck] = useState<'idle' | 'checking' | 'connected' | 'rejected' | 'unavailable'>('idle')
  const [copied, setCopied] = useState('')
  const { url, instructions } = mcpSetup()

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
    } catch {
      setCopied('Clipboard unavailable. Select the URL or setup instructions to copy them manually.')
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const token = z.string().trim().min(1).safeParse(new FormData(form).get('mcp-token'))
    if (!token.success) return
    form.reset()
    setCheck('checking')
    try {
      setCheck(await checkMcpConnection(url, token.data))
    } catch {
      setCheck('unavailable')
    }
  }

  return (
    <section
      className="settings-panel mcp-access-settings"
      id="mcp-setup"
      tabIndex={-1}
      aria-labelledby="mcp-setup-title"
    >
      <header>
        <Cable aria-hidden="true" />
        <div>
          <h2 id="mcp-setup-title">MCP setup</h2>
          <p>Connect an MCP client with a scoped token from Agent tokens.</p>
        </div>
        {config.data && <span className="scope-badge">{config.data.enabled ? 'Enabled' : 'Disabled'}</span>}
      </header>
      <div className="settings-panel-body">
        {config.isPending && <StateMessage compact kind="loading" title="Checking server settings" />}
        {config.isError && (
          <StateMessage
            compact
            kind="error"
            title="MCP settings unavailable"
            action={
              <button type="button" className="secondary-action" onClick={() => void config.refetch()}>
                Retry
              </button>
            }
          />
        )}
        {config.data?.enabled ? (
          <>
            <label className="settings-field mcp-access-field">
              MCP server URL
              <input readOnly value={url.href} />
            </label>
            <div className="token-actions">
              <button
                className="secondary-action"
                type="button"
                onClick={() => void copy(url.href, 'MCP URL copied')}
              >
                Copy MCP URL
              </button>
              <button
                className="secondary-action"
                type="button"
                onClick={() => void copy(instructions, 'MCP setup copied')}
              >
                Copy MCP setup
              </button>
              <Link
                className="secondary-action"
                to="/activity"
                search={{ view: 'activity', via: 'mcp', range: '7d' }}
              >
                View MCP activity
              </Link>
            </div>
            {copied && <p role="status">{copied}</p>}
            <details>
              <summary>Client instructions</summary>
              <p className="mcp-setup-instructions">{instructions}</p>
            </details>
            <form className="mcp-access-check" onSubmit={(event) => void submit(event)}>
              <label className="settings-field mcp-access-field">
                Agent token for connection check
                <input
                  name="mcp-token"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  disabled={check === 'checking'}
                />
              </label>
              <button type="submit" className="secondary-action" disabled={check === 'checking'}>
                Check connection
              </button>
            </form>
            {check === 'checking' && <StateMessage compact kind="loading" title="Checking MCP connection" />}
            {check === 'connected' && (
              <StateMessage
                compact
                kind="success"
                title="MCP connection works"
                description="Sangam accepted the token and returned its tool catalog."
              />
            )}
            {check === 'rejected' && (
              <StateMessage
                compact
                kind="error"
                title="Token rejected"
                description="Use an active Sangam agent token."
              />
            )}
            {check === 'unavailable' && (
              <StateMessage
                compact
                kind="error"
                title="MCP connection failed"
                description="Check the server, proxy, and SANGAM_MCP_ALLOWED_HOSTS, then retry."
              />
            )}
            <p>
              To disable MCP, set <code>SANGAM_MCP_ENABLED=false</code> and restart Sangam.
            </p>
          </>
        ) : (
          config.data && (
            <StateMessage
              compact
              kind="empty"
              title="MCP is disabled"
              description="Set SANGAM_MCP_ENABLED=true and restart Sangam to accept MCP connections."
            />
          )
        )}
      </div>
    </section>
  )
}
