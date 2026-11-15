import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { z } from 'zod'

const documentSchema = z.object({
  document_id: z.string(),
  current_revision_id: z.string(),
  content: z.string(),
})
const tokenSchema = z.object({ token: z.string() })
test.use({ video: 'on' })

test('real MCP host finds through Monty, recovers a checkpoint, and saves one revision', async ({
  page,
  request,
  browserName,
}, testInfo) => {
  const suffix = randomUUID()
  const created = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': suffix },
    data: {
      title: `MCP walkthrough ${suffix}`,
      path: `mcp/${suffix}.md`,
      content_type: 'text/markdown',
      content: `# Original\n\nFindable ${suffix}`,
    },
  })
  expect(created.status()).toBe(201)
  const original = documentSchema.parse(await created.json())
  const issued = await request.post('/api/v1/agent-tokens', {
    data: {
      actor_id: `agent:mcp-${suffix}`,
      display_name: 'MCP browser test',
      label: 'isolated e2e',
      scopes: ['read', 'search', 'update'].map((capability) => ({ capability, path_prefix: 'mcp/' })),
    },
  })
  expect(issued.status()).toBe(201)
  const { token } = tokenSchema.parse(await issued.json())
  await page.goto('/mcp-host.html')
  await page.getByLabel('Sangam API key').fill(token)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByText('Connected with existing permissions')).toBeVisible()
  await page.getByLabel('Find a document').fill(suffix)
  await page.getByRole('button', { name: 'Search documents', exact: true }).click()
  await page.getByRole('button', { name: `Open MCP walkthrough ${suffix}` }).click()
  const app = page.frameLocator('iframe[title="Sangam document workspace"]')
  await expect(app.getByText(`MCP walkthrough ${suffix}`, { exact: true })).toBeVisible()
  const editor = app.getByRole('textbox', { name: 'Document content' })
  await editor.click()
  await editor.press(browserName === 'webkit' ? 'Meta+A' : 'ControlOrMeta+A')
  await expect
    .poll(() => editor.evaluate((element) => element.ownerDocument.getSelection()?.toString()))
    .toContain('Original')
  await page.keyboard.insertText('# Recovered draft\n\nSaved through the actual MCP Apps bridge.')
  await expect(app.getByText('Draft backed up', { exact: true })).toBeVisible()
  expect(
    documentSchema.parse(await (await request.get(`/api/v1/documents/${original.document_id}`)).json())
      .content,
  ).toBe(original.content)
  await page.getByRole('button', { name: 'Reopen App', exact: true }).click()
  await expect(app.getByRole('textbox', { name: 'Document content' })).toHaveText(
    '# Recovered draft\n\nSaved through the actual MCP Apps bridge.',
    { useInnerText: true },
  )
  await app.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(app.getByText('All changes saved', { exact: true })).toBeVisible()
  const saved = documentSchema.parse(
    await (await request.get(`/api/v1/documents/${original.document_id}`)).json(),
  )
  expect(saved.content).toBe('# Recovered draft\n\nSaved through the actual MCP Apps bridge.')
  expect(saved.current_revision_id).not.toBe(original.current_revision_id)
  expect(await page.evaluate(() => Object.values(localStorage))).not.toContain(token)
  const frame = page.frames().find((candidate) => candidate.parentFrame() !== null)
  expect(await frame?.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('mcp-workspace-saved.png'), fullPage: true })
  if (testInfo.project.name === 'chromium-desktop') {
    for (const width of [320, 599, 601, 844]) {
      await page.setViewportSize({ width, height: 900 })
      await expect(app.getByRole('button', { name: 'Save', exact: true })).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await frame?.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
  }
})

test('a concurrent saved revision preserves the draft and reports the conflict', async ({
  page,
  request,
  browserName,
}) => {
  const suffix = randomUUID()
  const created = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': suffix },
    data: {
      title: `Concurrent ${suffix}`,
      path: `mcp/${suffix}.md`,
      content_type: 'text/markdown',
      content: `# Original\n${suffix}`,
    },
  })
  const original = documentSchema.parse(await created.json())
  const issued = await request.post('/api/v1/agent-tokens', {
    data: {
      actor_id: `agent:mcp-${suffix}`,
      display_name: 'MCP conflict test',
      label: 'isolated e2e',
      scopes: ['read', 'search', 'update'].map((capability) => ({ capability, path_prefix: 'mcp/' })),
    },
  })
  const { token } = tokenSchema.parse(await issued.json())
  await page.goto('/mcp-host.html')
  await page.getByLabel('Sangam API key').fill(token)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByLabel('Find a document').fill(suffix)
  await page.getByRole('button', { name: 'Search documents', exact: true }).click()
  await page.getByRole('button', { name: `Open Concurrent ${suffix}` }).click()
  const app = page.frameLocator('iframe[title="Sangam document workspace"]')
  const editor = app.getByRole('textbox', { name: 'Document content' })
  await editor.click()
  await editor.press(browserName === 'webkit' ? 'Meta+A' : 'ControlOrMeta+A')
  await expect
    .poll(() => editor.evaluate((element) => element.ownerDocument.getSelection()?.toString()))
    .toContain('Original')
  await page.keyboard.insertText('# Keep this draft')
  await expect(app.getByText('Draft backed up', { exact: true })).toBeVisible()
  const changed = await request.patch(`/api/v1/documents/${original.document_id}`, {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { content: '# Saved elsewhere', expected_revision_id: original.current_revision_id },
  })
  expect(changed.status()).toBe(200)
  await app.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(app.getByText('Saved document changed', { exact: true })).toBeVisible()
  await expect(app.getByRole('textbox', { name: 'Document content' })).toHaveText('# Keep this draft')
  await app.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(app.getByRole('alert')).toBeVisible()
  expect(
    documentSchema.parse(await (await request.get(`/api/v1/documents/${original.document_id}`)).json())
      .content,
  ).toBe('# Saved elsewhere')
})

test('another view cannot silently replace a locally edited shared draft', async ({
  page,
  request,
  browserName,
}) => {
  const suffix = randomUUID()
  const created = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': suffix },
    data: {
      title: `Shared ${suffix}`,
      path: `mcp/${suffix}.md`,
      content_type: 'text/markdown',
      content: `# Original\n${suffix}`,
    },
  })
  const original = documentSchema.parse(await created.json())
  const issued = await request.post('/api/v1/agent-tokens', {
    data: {
      actor_id: `agent:mcp-${suffix}`,
      display_name: 'Shared draft test',
      label: 'isolated e2e',
      scopes: ['read', 'search', 'update'].map((capability) => ({ capability, path_prefix: 'mcp/' })),
    },
  })
  const { token } = tokenSchema.parse(await issued.json())
  await page.goto('/mcp-host.html')
  await page.getByLabel('Sangam API key').fill(token)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByLabel('Find a document').fill(suffix)
  await page.getByRole('button', { name: 'Search documents', exact: true }).click()
  await page.getByRole('button', { name: `Open Shared ${suffix}` }).click()
  const app = page.frameLocator('iframe[title="Sangam document workspace"]')
  const editor = app.getByRole('textbox', { name: 'Document content' })
  await expect(editor).toContainText('Original')
  const workspaceId = new URL(page.url()).searchParams.get('workspace')
  const stateSchema = z.object({
    result: z.object({ structuredContent: z.object({ version: z.number(), draft: z.string().nullable() }) }),
  })
  async function otherView(action: {
    type: string
    workspace_id: string | null
    expected_version?: number
    content?: string
  }) {
    const reply = await request.post('/mcp/', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream' },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'mcp_app', arguments: { action } },
      },
    })
    expect(reply.status()).toBe(200)
    return stateSchema.parse(await reply.json()).result.structuredContent
  }
  const initial = await otherView({ type: 'refresh', workspace_id: workspaceId })
  await otherView({
    type: 'checkpoint',
    workspace_id: workspaceId,
    expected_version: initial.version,
    content: '# Other view checkpoint',
  })
  await editor.click()
  await editor.press(browserName === 'webkit' ? 'Meta+A' : 'ControlOrMeta+A')
  await page.keyboard.insertText('# Keep my local edits')
  await expect(app.getByText('Shared draft changed', { exact: true })).toBeVisible()
  await expect(editor).toHaveText('# Keep my local edits')
  expect((await otherView({ type: 'refresh', workspace_id: workspaceId })).draft).toBe(
    '# Other view checkpoint',
  )
  await app.getByRole('button', { name: 'Resolve shared draft', exact: true }).click()
  await app.getByRole('button', { name: 'Discard and reload', exact: true }).click()
  await expect(editor).toHaveText('# Other view checkpoint')
  await app.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(app.getByText('All changes saved', { exact: true })).toBeVisible()
  expect(
    documentSchema.parse(await (await request.get(`/api/v1/documents/${original.document_id}`)).json())
      .content,
  ).toBe('# Other view checkpoint')
})
