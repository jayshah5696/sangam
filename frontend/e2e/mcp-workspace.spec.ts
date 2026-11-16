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
  await expect(app.getByRole('heading', { name: `MCP walkthrough ${suffix}`, exact: true })).toBeVisible()
  const editor = app.getByRole('textbox', { name: 'Document content' })
  const editorRegion = await app.getByRole('region', { name: 'Document editor' }).boundingBox()
  const editorCanvas = await app.locator('.cm-editor').boundingBox()
  expect(editorRegion).not.toBeNull()
  expect(editorCanvas).not.toBeNull()
  expect(editorRegion?.height).toBeGreaterThanOrEqual(100)
  expect(Math.abs((editorCanvas?.height ?? 0) - (editorRegion?.height ?? 0))).toBeLessThan(5)
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
  const reopening = Promise.withResolvers<void>()
  const finishReopen = Promise.withResolvers<void>()
  const presentCall = z.object({ params: z.object({ name: z.literal('present') }) })
  await page.route('**/mcp/', async (route) => {
    if (
      route.request().method() !== 'POST' ||
      !presentCall.safeParse(route.request().postDataJSON()).success
    ) {
      await route.continue()
      return
    }
    const response = await route.fetch()
    reopening.resolve()
    await finishReopen.promise
    await route.fulfill({ response })
  })
  const oldFrame = page.frames().find((candidate) => candidate.parentFrame() !== null)
  await page.getByRole('button', { name: 'Reopen App', exact: true }).click()
  await reopening.promise
  await expect(editor).toHaveAttribute('contenteditable', 'false')
  finishReopen.resolve()
  await expect.poll(() => oldFrame?.isDetached()).toBe(true)
  expect(
    (await app.getByRole('region', { name: 'Document editor' }).boundingBox())?.height,
  ).toBeGreaterThanOrEqual(100)
  await app.getByRole('textbox', { name: 'Document content' }).scrollIntoViewIfNeeded()
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

test('App search opens several documents, restores drafts and active tab, and saves independently', async ({
  page,
  request,
  browserName,
}, testInfo) => {
  const suffix = randomUUID()
  async function create(title: string, path: string) {
    const response = await request.post('/api/v1/documents', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: { title, path, content_type: 'text/markdown', content: `# Original ${title}\n\n${suffix}` },
    })
    expect(response.status()).toBe(201)
    return documentSchema.parse(await response.json())
  }
  const firstTitle = `First ${suffix}`
  const secondTitle = `Second ${suffix}`
  const first = await create(firstTitle, `mcp/${suffix}-first.md`)
  const second = await create(secondTitle, `mcp/${suffix}-second.md`)
  await create(`Private ${suffix}`, `private/${suffix}.md`)
  const issued = await request.post('/api/v1/agent-tokens', {
    data: {
      actor_id: `agent:mcp-tabs-${suffix}`,
      display_name: 'MCP multiple documents',
      label: 'isolated e2e',
      scopes: ['read', 'search', 'update'].map((capability) => ({ capability, path_prefix: 'mcp/' })),
    },
  })
  const { token } = tokenSchema.parse(await issued.json())
  await page.goto('/mcp-host.html')
  await page.getByLabel('Sangam API key').fill(token)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByLabel('Find a document').fill(firstTitle)
  await page.getByRole('button', { name: 'Search documents', exact: true }).click()
  await page.getByRole('button', { name: `Open ${firstTitle}`, exact: true }).click()
  const app = page.frameLocator('iframe[title="Sangam document workspace"]')
  async function replace(text: string) {
    const editor = app.getByRole('textbox', { name: 'Document content' })
    await editor.click()
    await editor.press(browserName === 'webkit' ? 'Meta+A' : 'ControlOrMeta+A')
    await page.keyboard.insertText(text)
    await expect(app.getByText('Draft backed up', { exact: true })).toBeVisible()
  }
  await replace('# First recoverable draft')
  await app.getByText('Find documents', { exact: true }).click()
  await app.getByLabel('Search documents in Sangam').fill(suffix)
  await app.getByRole('button', { name: 'Search workspace', exact: true }).click()
  const results = app.getByRole('region', { name: 'Workspace search results' })
  await expect(results.getByRole('button', { name: `Open ${secondTitle}`, exact: true })).toBeVisible()
  await expect(results.getByText(`Private ${suffix}`, { exact: true })).toHaveCount(0)
  const navigationStarted = Promise.withResolvers<void>()
  const finishNavigation = Promise.withResolvers<void>()
  const openAction = z.object({
    params: z.object({
      name: z.literal('mcp_app'),
      arguments: z.object({ action: z.object({ type: z.literal('open') }) }),
    }),
  })
  await page.route('**/mcp/', async (route) => {
    if (
      route.request().method() !== 'POST' ||
      !openAction.safeParse(route.request().postDataJSON()).success
    ) {
      await route.continue()
      return
    }
    const response = await route.fetch()
    navigationStarted.resolve()
    await finishNavigation.promise
    await route.fulfill({ response })
  })
  await results.getByRole('button', { name: `Open ${secondTitle}`, exact: true }).click()
  await navigationStarted.promise
  await expect(app.getByLabel('Document content')).toHaveAttribute('contenteditable', 'false')
  finishNavigation.resolve()
  await expect(app.getByRole('tab', { name: secondTitle, exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(app.getByRole('tab', { name: secondTitle, exact: true })).toBeFocused()
  await replace('# Second recoverable draft')
  await app.getByRole('tab', { name: firstTitle, exact: true }).click()
  await expect(app.getByRole('textbox', { name: 'Document content' })).toHaveText('# First recoverable draft')
  await app.getByRole('tab', { name: firstTitle, exact: true }).press('ArrowRight')
  await expect(app.getByRole('textbox', { name: 'Document content' })).toHaveText(
    '# Second recoverable draft',
  )
  for (const document of [first, second]) {
    expect(
      documentSchema.parse(await (await request.get(`/api/v1/documents/${document.document_id}`)).json())
        .content,
    ).toBe(document.content)
  }
  await page.reload()
  await page.getByLabel('Sangam API key').fill(token)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(app.getByRole('tab', { name: secondTitle, exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(app.getByRole('tab', { name: firstTitle, exact: true })).toBeVisible()
  await expect(app.getByRole('textbox', { name: 'Document content' })).toHaveText(
    '# Second recoverable draft',
  )
  await expect(app.getByRole('button', { name: `Close ${secondTitle}`, exact: true })).toBeDisabled()
  await page
    .locator('iframe[title="Sangam document workspace"]')
    .screenshot({ path: testInfo.outputPath('mcp-multiple-documents.png') })
  await app.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(app.getByText('All changes saved', { exact: true })).toBeVisible()
  await app.getByRole('button', { name: `Close ${secondTitle}`, exact: true }).click()
  await expect(app.getByRole('tab', { name: secondTitle, exact: true })).toHaveCount(0)
  await expect(app.getByRole('textbox', { name: 'Document content' })).toHaveText('# First recoverable draft')
  await app.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(app.getByText('All changes saved', { exact: true })).toBeVisible()
  expect(
    documentSchema.parse(await (await request.get(`/api/v1/documents/${first.document_id}`)).json()).content,
  ).toBe('# First recoverable draft')
  expect(
    documentSchema.parse(await (await request.get(`/api/v1/documents/${second.document_id}`)).json()).content,
  ).toBe('# Second recoverable draft')
  const frame = page.frames().find((candidate) => candidate.parentFrame() !== null)
  expect(await frame?.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('mcp-multiple-documents-saved.png'), fullPage: true })
})
