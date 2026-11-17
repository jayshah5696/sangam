import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { z } from 'zod'

const documentSchema = z.object({
  document_id: z.string(),
  current_revision_id: z.string(),
  content: z.string(),
})
const tokenSchema = z.object({ token: z.string() })
test.use({ video: 'on' })

test('MCP App prepares, reviews, recovers apply, and dismisses owned proposals', async ({
  page,
  request,
}, testInfo) => {
  // This covers three durable mutations, transport recovery, and the responsive review layouts.
  test.setTimeout(60_000)
  const suffix = randomUUID()
  const created = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': suffix },
    data: {
      title: `Proposal review ${suffix}`,
      path: `mcp/${suffix}.md`,
      content: '# Original review source',
      content_type: 'text/markdown',
    },
  })
  expect(created.status()).toBe(201)
  const document = documentSchema.parse(await created.json())
  const issued = await request.post('/api/v1/agent-tokens', {
    data: {
      actor_id: `agent:mcp-review-${suffix}`,
      display_name: 'MCP reviewer',
      label: 'isolated e2e',
      scopes: ['read', 'search', 'update'].map((capability) => ({ capability, path_prefix: 'mcp/' })),
    },
  })
  const { token } = tokenSchema.parse(await issued.json())
  await page.goto(`/mcp-host.html?document=${document.document_id}`)
  await page.getByLabel('Sangam API key').fill(token)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByLabel('Find a document').fill(suffix)
  await page.getByRole('button', { name: 'Search documents', exact: true }).click()
  await page.getByRole('button', { name: `Open Proposal review ${suffix}`, exact: true }).click()
  const app = page.frameLocator('iframe[title="Sangam document workspace"]')
  await app.getByRole('button', { name: 'Review proposals', exact: true }).click()
  await app.getByRole('button', { name: 'New proposal', exact: true }).click()
  await app.getByLabel('Proposal summary', { exact: true }).fill('Clarify the source')
  await app.getByLabel('Proposed content', { exact: true }).fill('# Suggested wording')
  await app.getByRole('button', { name: 'Create proposal', exact: true }).click()
  await expect(app.getByRole('heading', { name: 'Clarify the source', exact: true })).toBeVisible()
  expect(
    documentSchema.parse(await (await request.get(`/api/v1/documents/${document.document_id}`)).json())
      .current_revision_id,
  ).toBe(document.current_revision_id)
  await app.getByLabel('Reviewed wording', { exact: true }).fill('# Human reviewed wording')
  await expect(app.getByLabel('Revision comparison')).toBeVisible()
  await expect(
    app.getByLabel('Revision comparison').getByText('Original review source', { exact: false }),
  ).toBeVisible()
  await expect(
    app.getByLabel('Revision comparison').getByText('Human reviewed wording', { exact: false }),
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('mcp-proposal-comparison.png'), fullPage: true })
  if (testInfo.project.name === 'chromium-desktop') {
    for (const viewport of [
      { width: 599, height: 844 },
      { width: 601, height: 844 },
      { width: 320, height: 568 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport)
      expect(
        await app.locator('html').evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true)
      const apply = app.getByRole('button', { name: 'Apply proposal', exact: true })
      await apply.scrollIntoViewIfNeeded()
      await expect(apply).toBeInViewport()
      await expect(app.getByRole('button', { name: 'Dismiss proposal', exact: true })).toBeInViewport()
      await page.screenshot({
        path: testInfo.outputPath(`mcp-proposal-${viewport.width}x${viewport.height}.png`),
        fullPage: true,
      })
    }
    await page.setViewportSize(testInfo.project.use.viewport ?? { width: 1440, height: 900 })
    const frame = page.locator('iframe[title="Sangam document workspace"]')
    // The App has its own 600px breakpoint, independent of the host document rail.
    for (const width of [599, 601]) {
      await frame.evaluate((element, width) => {
        element.style.width = `${width}px`
      }, width)
      await expect.poll(() => app.locator('html').evaluate((element) => element.clientWidth)).toBe(width)
      expect(
        await app.locator('html').evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true)
      await app.getByRole('button', { name: 'Apply proposal', exact: true }).scrollIntoViewIfNeeded()
      await expect(app.getByRole('button', { name: 'Dismiss proposal', exact: true })).toBeInViewport()
      await frame.screenshot({ path: testInfo.outputPath(`mcp-proposal-frame-${width}.png`) })
    }
    await frame.evaluate((element) => {
      element.style.width = '100%'
    })
  }
  const applyAction = z.object({
    params: z.object({ arguments: z.object({ action: z.object({ type: z.literal('proposal_apply') }) }) }),
  })
  let dropped = false
  await page.route('**/mcp/', async (route) => {
    if (
      dropped ||
      route.request().method() !== 'POST' ||
      !applyAction.safeParse(route.request().postDataJSON()).success
    ) {
      await route.continue()
      return
    }
    dropped = true
    await route.fetch()
    await route.abort('failed')
  })
  await app.getByRole('button', { name: 'Apply proposal', exact: true }).click()
  await expect(app.getByRole('button', { name: 'Retry apply', exact: true })).toBeEnabled()
  await app.getByRole('button', { name: 'Retry apply', exact: true }).click()
  await expect(app.getByText('Proposal applied', { exact: true })).toBeVisible()
  const saved = documentSchema.parse(
    await (await request.get(`/api/v1/documents/${document.document_id}`)).json(),
  )
  expect(saved.content).toBe('# Human reviewed wording')
  expect(saved.current_revision_id).not.toBe(document.current_revision_id)
  const history = z
    .array(z.object({ revision_id: z.string() }))
    .parse(await (await request.get(`/api/v1/documents/${document.document_id}/history`)).json())
  expect(history).toHaveLength(2)
  await app.getByRole('button', { name: 'New proposal', exact: true }).click()
  await app.getByLabel('Proposal summary', { exact: true }).fill('Discard this suggestion')
  await app.getByLabel('Proposed content', { exact: true }).fill('# Dismissed wording')
  await app.getByRole('button', { name: 'Create proposal', exact: true }).click()
  await app.getByLabel('Dismissal reason', { exact: true }).fill('Keep the reviewed version')
  await app.getByRole('button', { name: 'Dismiss proposal', exact: true }).click()
  await expect(app.getByText('Proposal dismissed', { exact: true })).toBeVisible()
  expect(
    documentSchema.parse(await (await request.get(`/api/v1/documents/${document.document_id}`)).json())
      .content,
  ).toBe('# Human reviewed wording')
  await app.getByRole('button', { name: 'Close review', exact: true }).click()
  await expect(app.getByRole('textbox', { name: 'Document content' })).toHaveText('# Human reviewed wording')
  await expect(app.getByRole('button', { name: 'Review proposals', exact: true })).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('mcp-proposal-review.png'), fullPage: true })
})

test('PDF App renders authorized bytes, restores its page, and saves a note without changing the PDF', async ({
  page,
  request,
}, testInfo) => {
  const suffix = randomUUID()
  const bytes = readFileSync(path.join(import.meta.dirname, 'assets/multipage.pdf'))
  const imported = await request.post(`/api/v1/pdfs?title=PDF-${suffix}&path=mcp/${suffix}.pdf`, {
    headers: { 'Content-Type': 'application/pdf', 'Idempotency-Key': suffix },
    data: bytes,
  })
  expect(imported.status()).toBe(201)
  const document = documentSchema.parse(await imported.json())
  const issued = await request.post('/api/v1/agent-tokens', {
    data: {
      actor_id: `agent:mcp-pdf-${suffix}`,
      display_name: 'MCP PDF reader',
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
  await page.getByRole('button', { name: `Open PDF-${suffix}`, exact: true }).click()
  const app = page.frameLocator('iframe[title="Sangam document workspace"]')
  await expect(app.getByRole('img', { name: 'PDF page 1', exact: true })).toHaveAttribute(
    'data-rendered',
    'true',
  )
  await app.getByRole('button', { name: 'Next PDF page', exact: true }).click()
  await expect(app.getByRole('img', { name: 'PDF page 2', exact: true })).toHaveAttribute(
    'data-rendered',
    'true',
  )
  if (testInfo.project.use.hasTouch)
    expect(
      (await app.getByText('Search this PDF', { exact: true }).boundingBox())?.height,
    ).toBeGreaterThanOrEqual(44)
  await app.getByText('Search this PDF', { exact: true }).click()
  await app.getByLabel('PDF search', { exact: true }).fill('Sangam Technical Architecture')
  await app.getByRole('button', { name: 'Search PDF pages', exact: true }).click()
  await app.getByRole('button', { name: /^Page 2:/ }).click()
  const passage = app.locator('.textLayer span').filter({ hasText: 'Sangam Technical Architecture' }).first()
  const passageWidth = (await passage.boundingBox())?.width ?? 0
  const pageWidth =
    (await app.getByRole('img', { name: 'PDF page 2', exact: true }).boundingBox())?.width ?? 1
  // This fixture's title covers 36% of the PDF page. Selection must cover the same glyphs.
  expect(passageWidth / pageWidth).toBeGreaterThan(0.3)
  expect(passageWidth / pageWidth).toBeLessThan(0.4)
  await passage.evaluate((element) => {
    const range = element.ownerDocument.createRange()
    range.selectNodeContents(element)
    const selection = element.ownerDocument.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    element.closest('.textLayer')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await app.getByRole('button', { name: 'Highlight selected passage', exact: true }).click()
  await expect(app.locator('.mcp-pdf-mark')).toHaveCount(1)
  await app.getByLabel('Page note', { exact: true }).fill('A note through the MCP bridge')
  await app.getByRole('button', { name: 'Next PDF page', exact: true }).click()
  await expect(app.getByRole('img', { name: 'PDF page 2', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Reopen App', exact: true }).click()
  await expect(page.getByText(/Save or discard the page note before reopening/)).toBeVisible()
  await expect(app.getByLabel('Page note', { exact: true })).toHaveValue('A note through the MCP bridge')
  const noteAction = z.object({
    params: z.object({
      arguments: z.object({ action: z.object({ type: z.literal('pdf_note') }) }),
    }),
  })
  let droppedNoteResponse = false
  await page.route('**/mcp/', async (route) => {
    if (
      droppedNoteResponse ||
      route.request().method() !== 'POST' ||
      !noteAction.safeParse(route.request().postDataJSON()).success
    ) {
      await route.continue()
      return
    }
    droppedNoteResponse = true
    await route.fetch()
    await route.abort('failed')
  })
  await app.getByRole('button', { name: 'Save page note', exact: true }).click()
  await expect(app.getByRole('button', { name: 'Retry page note', exact: true })).toBeEnabled()
  await app.getByRole('button', { name: 'Retry page note', exact: true }).click()
  await expect(app.getByText('A note through the MCP bridge', { exact: true })).toBeVisible()
  const savedNotes = z
    .array(z.object({ note: z.string().nullable() }))
    .parse(await (await request.get(`/api/v1/pdfs/${document.document_id}/annotations`)).json())
  expect(savedNotes.filter((item) => item.note === 'A note through the MCP bridge')).toHaveLength(1)
  const oldPdfFrame = page.frames().find((candidate) => candidate.parentFrame() !== null)
  await page.getByRole('button', { name: 'Reopen App', exact: true }).click()
  await expect.poll(() => oldPdfFrame?.isDetached()).toBe(true)
  await expect(app.getByRole('img', { name: 'PDF page 2', exact: true })).toHaveAttribute(
    'data-rendered',
    'true',
  )
  await expect(app.getByText('A note through the MCP bridge', { exact: true })).toBeVisible()
  await expect((await request.get(`/api/v1/pdfs/${document.document_id}/content`)).body()).resolves.toEqual(
    bytes,
  )
  expect(
    documentSchema.parse(await (await request.get(`/api/v1/documents/${document.document_id}`)).json())
      .current_revision_id,
  ).toBe(document.current_revision_id)
  await page
    .locator('iframe[title="Sangam document workspace"]')
    .screenshot({ path: testInfo.outputPath('mcp-pdf-notes.png') })
  await app.locator('.mcp-pdf-scroll').evaluate((element) => {
    element.scrollTop = 0
  })
  await page
    .locator('iframe[title="Sangam document workspace"]')
    .screenshot({ path: testInfo.outputPath('mcp-pdf.png') })
  if (testInfo.project.name === 'chromium-desktop') {
    for (const viewport of [
      { width: 599, height: 844 },
      { width: 601, height: 844 },
      { width: 320, height: 568 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport)
      await expect(app.getByRole('img', { name: 'PDF page 2', exact: true })).toHaveAttribute(
        'data-rendered',
        'true',
      )
      expect(
        await app.locator('html').evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true)
      expect((await app.locator('.mcp-pdf-scroll').boundingBox())?.height).toBeGreaterThanOrEqual(100)
      await app.getByRole('button', { name: 'Next PDF page', exact: true }).scrollIntoViewIfNeeded()
      await expect(app.getByRole('button', { name: 'Next PDF page', exact: true })).toBeInViewport()
      await page
        .locator('iframe[title="Sangam document workspace"]')
        .screenshot({ path: testInfo.outputPath(`mcp-pdf-${viewport.width}x${viewport.height}.png`) })
    }
    await page.setViewportSize({ width: 844, height: 844 })
    for (const height of [499, 501]) {
      await page.locator('iframe[title="Sangam document workspace"]').evaluate((element, height) => {
        element.style.height = `${height}px`
      }, height)
      await expect.poll(() => app.locator('html').evaluate((element) => element.clientHeight)).toBe(height)
      expect((await app.locator('.mcp-pdf-scroll').boundingBox())?.height).toBeGreaterThanOrEqual(100)
      await page
        .locator('iframe[title="Sangam document workspace"]')
        .screenshot({ path: testInfo.outputPath(`mcp-pdf-frame-${height}.png`) })
    }
  }
})

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
  await page.addInitScript(() => {
    localStorage.setItem(
      'sangam.workspace-preferences.v1',
      JSON.stringify({ theme: 'cobalt', uiFont: 'plex' }),
    )
  })
  await page.goto('/mcp-host.html')
  await page.getByLabel('Sangam API key').fill(token)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'cobalt')
  await page.getByLabel('Find a document').fill(suffix)
  await page.getByRole('button', { name: 'Search documents', exact: true }).click()
  await page.getByRole('button', { name: `Open MCP walkthrough ${suffix}` }).click()
  const app = page.frameLocator('iframe[title="Sangam document workspace"]')
  await expect(app.getByRole('heading', { name: `MCP walkthrough ${suffix}`, exact: true })).toBeVisible()
  await expect(app.locator('html')).toHaveCSS('--accent', '#1769c2')
  await page.getByLabel('Theme', { exact: true }).selectOption('midnight')
  await expect(app.locator('html')).toHaveCSS('--accent', '#5b59dc')
  await expect(app.locator('html')).toHaveCSS('color-scheme', 'dark')
  const frameBounds = await page.locator('iframe').boundingBox()
  expect((frameBounds?.y ?? 0) + (frameBounds?.height ?? 0)).toBeLessThanOrEqual(
    page.viewportSize()!.height + 1,
  )
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
  let subscribed = false
  const listenRequest = z.object({ method: z.literal('subscriptions/listen') })
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/mcp/')
      subscribed ||= listenRequest.safeParse(request.postDataJSON()).success
  })
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
  await expect.poll(() => subscribed).toBe(true)
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
  const checkpointStarted = Promise.withResolvers<void>()
  const releaseCheckpoint = Promise.withResolvers<void>()
  const checkpointAction = z.object({
    params: z.object({ arguments: z.object({ action: z.object({ type: z.literal('checkpoint') }) }) }),
  })
  await page.route('**/mcp/', async (route) => {
    if (
      route.request().method() !== 'POST' ||
      !checkpointAction.safeParse(route.request().postDataJSON()).success
    ) {
      await route.continue()
      return
    }
    checkpointStarted.resolve()
    await releaseCheckpoint.promise
    await route.continue()
  })
  await editor.click()
  await editor.press(browserName === 'webkit' ? 'Meta+A' : 'ControlOrMeta+A')
  await page.keyboard.insertText('# Keep my local edits')
  await checkpointStarted.promise
  try {
    await otherView({
      type: 'checkpoint',
      workspace_id: workspaceId,
      expected_version: initial.version,
      content: '# Other view checkpoint',
    })
  } finally {
    releaseCheckpoint.resolve()
  }
  await expect(app.getByText('Shared draft changed', { exact: true })).toBeVisible()
  await expect(editor).toHaveText('# Keep my local edits')
  expect((await otherView({ type: 'refresh', workspace_id: workspaceId })).draft).toBe(
    '# Other view checkpoint',
  )
  await app.getByRole('button', { name: 'Resolve shared draft', exact: true }).click()
  await app.getByRole('button', { name: 'Discard and reload', exact: true }).click()
  await expect(editor).toHaveText('# Other view checkpoint')
  const viewStarted = Promise.withResolvers<void>()
  const releaseView = Promise.withResolvers<void>()
  const viewAction = z.object({
    params: z.object({ arguments: z.object({ action: z.object({ type: z.literal('view') }) }) }),
  })
  await page.route('**/mcp/', async (route) => {
    if (
      route.request().method() !== 'POST' ||
      !viewAction.safeParse(route.request().postDataJSON()).success
    ) {
      await route.continue()
      return
    }
    const response = await route.fetch()
    viewStarted.resolve()
    await releaseView.promise
    await route.fulfill({ response })
  })
  await editor.press('Home')
  await editor.press('ArrowRight')
  await viewStarted.promise
  try {
    const save = app.getByRole('button', { name: 'Save', exact: true })
    await expect(save).toBeEnabled()
    await save.click()
    expect(
      documentSchema.parse(await (await request.get(`/api/v1/documents/${original.document_id}`)).json())
        .current_revision_id,
    ).toBe(original.current_revision_id)
  } finally {
    releaseView.resolve()
  }
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
  const firstTab = app.getByRole('tab', { name: firstTitle, exact: true })
  await expect(firstTab).toBeEnabled()
  const refreshStarted = Promise.withResolvers<void>()
  const releaseRefresh = Promise.withResolvers<void>()
  const refreshAction = z.object({
    params: z.object({ arguments: z.object({ action: z.object({ type: z.literal('refresh') }) }) }),
  })
  let holdRefresh = true
  await page.route('**/mcp/', async (route) => {
    if (
      !holdRefresh ||
      route.request().method() !== 'POST' ||
      !refreshAction.safeParse(route.request().postDataJSON()).success
    ) {
      await route.fallback()
      return
    }
    holdRefresh = false
    const response = await route.fetch()
    refreshStarted.resolve()
    await releaseRefresh.promise
    await route.fulfill({ response })
  })
  await refreshStarted.promise
  try {
    // Background polling must not remove focus or swallow an arrow-key action.
    await expect(firstTab).toBeEnabled()
    await firstTab.press('ArrowRight')
  } finally {
    releaseRefresh.resolve()
  }
  await expect(app.getByRole('textbox', { name: 'Document content' })).toHaveText(
    '# Second recoverable draft',
  )
  for (const document of [first, second]) {
    expect(
      documentSchema.parse(await (await request.get(`/api/v1/documents/${document.document_id}`)).json())
        .content,
    ).toBe(document.content)
  }
  await app.getByRole('button', { name: `Compare ${firstTitle}`, exact: true }).click()
  const comparison = app.getByRole('region', { name: 'Comparison document' })
  if ((await app.locator('details.mcp-comparison').getAttribute('open')) === null)
    await app.getByText('Comparison', { exact: true }).click()
  await expect(comparison).toContainText('# First recoverable draft')
  await expect(comparison.getByText('Draft checkpoint', { exact: true })).toBeVisible()
  await comparison.locator('pre').scrollIntoViewIfNeeded()
  await expect(comparison.locator('pre')).toBeInViewport()
  await comparison.getByRole('button', { name: 'Edit this document', exact: true }).scrollIntoViewIfNeeded()
  await expect(comparison.getByRole('button', { name: 'Edit this document', exact: true })).toBeInViewport()
  await page
    .locator('iframe[title="Sangam document workspace"]')
    .screenshot({ path: testInfo.outputPath('mcp-comparison.png') })
  await app.getByText('Comparison', { exact: true }).click()
  const editor = app.getByRole('textbox', { name: 'Document content' })
  const viewRequest = z.object({
    params: z.object({
      arguments: z.object({
        action: z.object({
          type: z.literal('view'),
          location: z.object({ anchor: z.literal(0), head: z.literal(3) }),
        }),
      }),
    }),
  })
  const viewSaved = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/mcp/' &&
      viewRequest.safeParse(response.request().postDataJSON()).success,
  )
  await editor.focus()
  await editor.press('Home')
  await editor.press('Shift+ArrowRight')
  await editor.press('Shift+ArrowRight')
  await editor.press('Shift+ArrowRight')
  expect((await viewSaved).ok()).toBe(true)
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
  await app.getByRole('textbox', { name: 'Document content' }).focus()
  await expect
    .poll(() => editor.evaluate((element) => element.ownerDocument.getSelection()?.toString()))
    .toBe('# S')
  await expect(app.locator('details.mcp-comparison')).toHaveCount(1)
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
