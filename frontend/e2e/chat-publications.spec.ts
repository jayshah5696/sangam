import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { expect, test } from './fixtures'

async function createPublication(request: import('@playwright/test').APIRequestContext) {
  const suffix = randomUUID().slice(0, 8)
  const document = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      title: `Publication evidence ${suffix}`,
      content: '# Publication evidence\n',
      content_type: 'text/markdown',
      path: `published/evidence-${suffix}.md`,
    },
  })
  expect(document.ok(), await document.text()).toBeTruthy()
  const createdDocument = (await document.json()) as { document_id: string }
  const publication = await request.post('/api/v1/publications', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      document_id: createdDocument.document_id,
      slug: `evidence-${suffix}`,
      access_policy: 'unlisted',
    },
  })
  expect(publication.ok(), await publication.text()).toBeTruthy()
  return (await publication.json()) as { publication_id: string; document_id: string }
}

async function createChatThread(request: import('@playwright/test').APIRequestContext) {
  const response = await request.post('/api/v1/chatkit', {
    data: {
      type: 'threads.create',
      params: {
        input: {
          content: [{ type: 'input_text', text: 'Inspector history thread' }],
          attachments: [],
          inference_options: { model: 'openai/gpt-5.4-nano' },
        },
      },
    },
    headers: { 'X-Sangam-Workspace-Context': '1' },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  const events = (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as { type: string; thread?: { id: string } })
  return events.find((event) => event.type === 'thread.created')!.thread!.id
}

test('workspace chat opens without a document and reports transport setup truthfully', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Ask workspace' }).click()
  await expect(page).toHaveURL(/\/chat$/)
  await expect(page.getByRole('heading', { name: 'Workspace chat' })).toBeVisible()
  const runtime = await page.request.get('/api/v1/chat/config')
  expect(runtime.ok(), await runtime.text()).toBeTruthy()
  const config = (await runtime.json()) as { transport_status: 'ready' | 'misconfigured' }
  if (config.transport_status === 'misconfigured') {
    await expect(page.getByRole('alert')).toContainText('ChatKit browser transport needs setup')
    await expect(page.locator('openai-chatkit')).toHaveCount(0)
  } else {
    await expect(page.getByLabel('Active chat context')).toContainText('Whole workspace')
    await expect(page.getByLabel('Active chat context')).toContainText('No document pinned')
  }
  const proposals = await page.request.get('/api/v1/chat/proposals')
  expect(proposals.ok(), await proposals.text()).toBeTruthy()

  const evidenceDir = process.env.SANGAM_EVIDENCE_DIR
  if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, 'workspace-chat.png') })
})

test('document chat hands exact context to the full-page route', async ({
  page,
  seededWorkspace,
}, testInfo) => {
  await page.goto(`/documents/${seededWorkspace.documentId}`)
  await expect(page.getByRole('heading', { name: seededWorkspace.documentTitle })).toBeVisible()
  const isMobileLayout = testInfo.project.name !== 'chromium-desktop'
  if (isMobileLayout) await page.getByRole('button', { name: 'Open document inspector' }).click()
  await page.getByRole('tab', { name: 'chat', exact: true }).click()
  if (!isMobileLayout) {
    await expect(page.getByText('Document chat', { exact: true })).toBeVisible()
    await expect(page.locator('.inspector-chat-surface .chat-panel-compact')).toBeVisible()
    await page.getByRole('button', { name: 'Open full chat' }).click()
  }
  await expect(page).toHaveURL(/\/chat\?document=/)
  await expect(page.getByRole('heading', { name: 'Workspace chat' })).toBeVisible()
  await expect(page.getByLabel('Active chat context')).toContainText(seededWorkspace.documentTitle)
  await expect(page.getByRole('button', { name: 'Return to document' })).toBeVisible()
  if (isMobileLayout) {
    await expect(page.locator('.workspace-chat-page')).toHaveCSS('overflow', 'hidden')
    await expect(page.locator('.workspace-chat-surface')).toHaveCSS('overflow', 'hidden')
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390)
    const back = page.getByRole('button', { name: 'Return to document' })
    await expect(back).toHaveCSS('min-height', '44px')
    if (testInfo.project.name === 'chromium-touch-mobile') await back.tap()
    else await back.click()
    await expect(page).toHaveURL(new RegExp(`/documents/${seededWorkspace.documentId}$`))
    await expect(page.getByRole('heading', { name: seededWorkspace.documentTitle })).toBeVisible()
  }
})

test('compact chat exposes shared new-chat and history controls', async ({
  page,
  request,
  seededWorkspace,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop inspector only')
  const threadId = await createChatThread(request)
  await page.addInitScript((value) => localStorage.setItem('sangam.chat-thread.workspace', value), threadId)
  await page.goto(`/documents/${seededWorkspace.documentId}`)
  await page.getByRole('tab', { name: 'chat', exact: true }).click()

  const compact = page.locator('.inspector-chat-surface')
  const newChat = compact.getByRole('button', { name: 'New chat' })
  const history = compact.getByRole('button', { name: 'Chat history' })
  await expect(newChat).toBeVisible()
  await expect(history).toBeVisible()
  await expect(newChat).toHaveAttribute('title', 'New chat')
  await expect(history).toHaveAttribute('title', 'Chat history')
  for (const control of [newChat, history]) {
    const bounds = await control.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.width).toBeGreaterThanOrEqual(32)
    expect(bounds!.height).toBeGreaterThanOrEqual(32)
    await control.focus()
    await expect(control).toBeFocused()
  }

  await page.getByRole('button', { name: 'Open full chat' }).click()
  await expect(page).toHaveURL(/\/chat\?document=/)
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('sangam.chat-thread.workspace')))
    .toBe(threadId)

  await page.getByRole('button', { name: 'Return to document' }).click()
  await page.getByRole('tab', { name: 'chat', exact: true }).click()
  await newChat.click()
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('sangam.chat-thread.workspace')))
    .toBeNull()
  await history.click()
  await expect(compact).toBeVisible()

  const evidenceDir = process.env.SANGAM_EVIDENCE_DIR
  if (evidenceDir) {
    await compact.screenshot({ path: path.join(evidenceDir, 'issue-118-compact-chat-controls.png') })
  }
})

test('compact document chat stays contained across supported inspector widths and resize controls', async ({
  page,
  seededWorkspace,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop inspector only')
  await page.goto(`/documents/${seededWorkspace.documentId}`)
  await page.getByRole('tab', { name: 'chat', exact: true }).click()

  const chatSurface = page.locator('.inspector-chat-surface')
  const chatShell = page.locator('.chat-panel-compact .chatkit-shell')
  await expect(chatSurface).toBeVisible()
  await expect(chatShell).toBeVisible()

  const handle = page.locator('.resize-handle[aria-label="Resize right sidebar"]')
  await expect(handle).toBeVisible()

  const sampleWidths = [290, 320, 480, 510, 720]
  for (const width of sampleWidths) {
    await page.evaluate((targetWidth) => {
      const stored = JSON.parse(localStorage.getItem('sangam.theme-preferences') || '{}')
      stored.rightWidth = targetWidth
      localStorage.setItem('sangam.theme-preferences', JSON.stringify(stored))
      window.dispatchEvent(new Event('storage'))
    }, width)
    await page.waitForTimeout(50)

    const surfaceBox = await chatSurface.boundingBox()
    const shellBox = await chatShell.boundingBox()
    expect(surfaceBox).not.toBeNull()
    expect(shellBox).not.toBeNull()
    expect(shellBox!.x + shellBox!.width).toBeLessThanOrEqual(surfaceBox!.x + surfaceBox!.width + 1.5)
    expect(shellBox!.width).toBeLessThanOrEqual(surfaceBox!.width + 1.5)

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    expect(overflows).toBe(false)
  }

  // Keyboard resize with Home (min 290) and End (max 720) and arrow keys
  await handle.focus()
  await page.keyboard.press('Home')
  const atMinBox = await chatShell.boundingBox()
  const surfaceMinBox = await chatSurface.boundingBox()
  expect(atMinBox!.width).toBeLessThanOrEqual(surfaceMinBox!.width + 1.5)

  await page.keyboard.press('End')
  const atMaxBox = await chatShell.boundingBox()
  const surfaceMaxBox = await chatSurface.boundingBox()
  expect(atMaxBox!.width).toBeLessThanOrEqual(surfaceMaxBox!.width + 1.5)

  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+ArrowLeft')
  const atShiftBox = await chatShell.boundingBox()
  const surfaceShiftBox = await chatSurface.boundingBox()
  expect(atShiftBox!.width).toBeLessThanOrEqual(surfaceShiftBox!.width + 1.5)

  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  )
  expect(overflows).toBe(false)
})

test('durable effect review restores exact pending and completed state', async ({
  page,
  request,
}, testInfo) => {
  const threadId = await createChatThread(request)
  const digest = 'a'.repeat(64)
  const baseEffect = {
    effect_id: 'effect-browser-review',
    thread_id: threadId,
    requested_by: 'human:jay',
    capability_id: 'create_document',
    capability_version: 2,
    argument_digest: digest,
    preview: {
      title: 'Reviewed browser draft',
      content: '# Exact source\n\nThis is the complete approved content.',
      content_type: 'text/markdown',
    },
    effect_class: 'write',
    risk: 'workspace',
    status: 'pending_approval',
    expires_at: '2099-08-23T12:00:00Z',
    resource_type: null,
    resource_id: null,
    result: null,
    failure: null,
    created_at: '2026-08-23T12:00:00Z',
    decided_at: null,
    completed_at: null,
  } as const
  let visibleEffect: Record<string, unknown> | null = { ...baseEffect }
  let decisionBody: Record<string, unknown> | null = null
  await page.route('**/api/v1/chat/effects**', async (route) => {
    const request = route.request()
    if (request.method() === 'POST') {
      decisionBody = request.postDataJSON() as Record<string, unknown>
      const denied = {
        ...baseEffect,
        status: 'denied',
        decided_at: '2026-08-23T12:01:00Z',
        completed_at: '2026-08-23T12:01:00Z',
      }
      visibleEffect = null
      await route.fulfill({ json: { effect: denied, client_result: { approved: false, status: 'denied' } } })
      return
    }
    await route.fulfill({ json: visibleEffect ? [visibleEffect] : [] })
  })
  await page.addInitScript((value) => localStorage.setItem('sangam.chat-thread.workspace', value), threadId)
  await page.goto('/chat')
  const review = page.getByRole('alertdialog', { name: /Create Markdown document/ })
  await expect(review).toBeVisible()
  await expect(review.getByLabel('Document content to create')).toHaveText(
    '# Exact source\n\nThis is the complete approved content.',
  )
  const deny = review.getByRole('button', { name: 'Cancel' })
  await deny.focus()
  await expect(deny).toBeFocused()
  if (testInfo.project.name.includes('touch-mobile')) {
    const target = await deny.boundingBox()
    expect(target).not.toBeNull()
    expect(target!.height).toBeGreaterThanOrEqual(44)
    await deny.tap()
  } else {
    await deny.click()
  }
  await expect(review).toBeHidden()
  expect(decisionBody).toEqual({ verdict: 'deny', argument_digest: digest, reason: null })
  await page.reload()
  await expect(review).toHaveCount(0)

  visibleEffect = {
    ...baseEffect,
    status: 'completed',
    resource_type: 'document',
    resource_id: 'document-browser-review',
    result: { document_id: 'document-browser-review', title: 'Reviewed browser draft' },
    decided_at: '2026-08-23T12:01:00Z',
    completed_at: '2026-08-23T12:01:01Z',
  }
  await page.reload()
  await expect(page.getByText('Document creation completed', { exact: true })).toBeVisible()
  await expect(page.getByText('Recorded effect effect-b', { exact: false })).toBeVisible()
  const evidenceDir = process.env.SANGAM_EVIDENCE_DIR
  if (evidenceDir) {
    await page.locator('.chat-panel').screenshot({
      path: path.join(evidenceDir, `issue-110-durable-effect-${testInfo.project.name}.png`),
    })
  }
})

test('publication dashboard filters and manages workspace publications', async ({ page, request }) => {
  await createPublication(request)
  await page.goto('/publications')
  const card = page.locator('.publication-card').filter({ hasText: 'Publication evidence' }).first()
  await expect(card).toBeVisible()
  await expect(card).toContainText('unlisted')
  await expect(card).toContainText('Live')
  await expect(card).toContainText('Token active')

  await page.getByLabel('Publication access policy').selectOption('public')
  await expect(card).toBeHidden()
  await page.getByLabel('Publication access policy').selectOption('unlisted')
  await card.getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog', { name: /Edit Publication evidence/ })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Access policy').selectOption('private')
  await dialog.getByRole('button', { name: 'Save publication' }).click()
  await expect(dialog).toBeHidden()
  await expect(card).toBeHidden()
  await page.getByLabel('Publication access policy').selectOption('private')
  await expect(card).toContainText('private')

  const evidenceDir = process.env.SANGAM_EVIDENCE_DIR
  if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, 'publications.png') })
})
