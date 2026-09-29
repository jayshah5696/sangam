import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import type { APIRequestContext } from '@playwright/test'
import { chatProposalSchema, documentSchema } from '../src/api'
import { expect, test as base } from './fixtures'

const fixtureSchema = z.object({ proposal: chatProposalSchema, source: documentSchema })
const threadEvent = z.object({ type: z.literal('thread.created'), thread: z.object({ id: z.string() }) })

const test = base.extend<{ editorial: z.infer<typeof fixtureSchema> }>({
  editorial: async ({ request, seededWorkspace }, provide) => {
    const created = await request.post('/api/v1/chatkit', {
      headers: { 'X-Sangam-Workspace-Context': '1' },
      data: {
        type: 'threads.create',
        params: {
          input: {
            content: [{ type: 'input_text', text: 'Review editorial draft' }],
            attachments: [],
            inference_options: { model: 'openai/gpt-5.4-nano' },
          },
        },
      },
    })
    expect(created.ok()).toBeTruthy()
    const event = (await created.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => threadEvent.safeParse(JSON.parse(line.slice(6))))
      .find((result) => result.success)
    if (!event?.success) throw new Error('Owner thread was not created')
    const seeded = await request.post('/__e2e/editorial', {
      data: { thread_id: event.data.thread.id, document_id: seededWorkspace.documentId },
    })
    expect(seeded.ok(), await seeded.text()).toBeTruthy()
    const fixture = fixtureSchema.parse(await seeded.json())
    await provide(fixture)
    await request.post(`/api/v1/chat/proposals/${fixture.proposal.proposal_id}/dismiss`, {
      data: { reason: 'Browser fixture finished' },
    })
  },
})

async function persisted(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/v1/documents/${id}`)
  expect(response.ok()).toBeTruthy()
  return documentSchema.parse(await response.json())
}

test('review inbox explains an empty queue', async ({ page }) => {
  await page.goto('/review')
  await expect(page.getByRole('heading', { name: 'Review changes' })).toBeVisible()
  await expect(page.getByText('Nothing needs review')).toBeVisible()
})

test('real late retrieval, source location, edited apply and exact persisted revision', async ({
  page,
  request,
  editorial,
}, testInfo) => {
  const { proposal, source } = editorial
  await page.goto('/review')
  const card = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: proposal.summary! }) })
  await expect(card.getByText('Make the draft match the source passage.')).toBeVisible()
  await expect(
    card.getByText('An external writing guide suggests a shorter tone; this has not been verified.'),
  ).toBeVisible()
  await expect(card.locator('.review-supporting-passages').first()).not.toContainText(
    'external writing guide',
  )
  await expect(card.locator('.review-retrieved-sources')).toContainText(source.title)
  const changedSource = await request.patch(`/api/v1/documents/${source.document_id}`, {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      expected_revision_id: source.current_revision_id,
      content: '# A newer source\n\nThe old passage is absent.',
    },
  })
  expect(changedSource.ok()).toBeTruthy()
  await card.getByRole('link', { name: 'Open source', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`revision=${source.current_revision_id}`))
  await expect(page.getByRole('region', { name: 'Exact cited passage' })).toBeInViewport()
  await expect(page.getByRole('region', { name: 'Exact cited passage' })).toBeFocused()
  await expect(page.getByRole('region', { name: 'Exact cited passage' })).toContainText(
    'Exact evidence for the editorial change.',
  )
  await page.screenshot({ path: testInfo.outputPath('editorial-pinned-source.png'), scale: 'css' })
  await page.goto('/review')
  await card.getByRole('button', { name: 'Edit wording' }).click()
  const edited = '# Editorial draft\n\nReviewer-approved wording, with exact source support.\n'
  await card.getByLabel('Editable proposed wording').fill(edited)
  await page.screenshot({ path: testInfo.outputPath('editorial-edited.png'), fullPage: true, scale: 'css' })
  await card.getByRole('button', { name: 'Apply edited change' }).click()
  await expect(card).toHaveCount(0)
  const saved = await persisted(request, proposal.document_id)
  expect(saved.content).toBe(edited)
  const listed = await request.get(`/api/v1/chat/proposals?thread_id=${proposal.thread_id}`)
  const applied = z.array(chatProposalSchema).parse(await listed.json())[0]
  expect(applied.content).toBe(proposal.content)
  expect(applied.applied_content).toBe(edited)
  expect(applied.applied_revision_id).toBe(saved.current_revision_id)
})

test('editorial pinned source can be kept, reopened with an evidence locator and sent as historical Ask context', async ({
  page,
  request,
  editorial,
}) => {
  const { proposal, source } = editorial
  await page.route('https://cdn.platform.openai.com/deployments/chatkit/chatkit.js', (route) =>
    route.fulfill({
      path: path.resolve('e2e/chatkit-editorial-driver.js'),
      contentType: 'application/javascript',
    }),
  )
  const changed = await request.patch(`/api/v1/documents/${source.document_id}`, {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      expected_revision_id: source.current_revision_id,
      content: '# New head\n\nThe cited passage is no longer here.',
    },
  })
  expect(changed.ok(), await changed.text()).toBeTruthy()
  await page.goto('/review')
  const review = page.getByRole('article').filter({
    has: page.getByRole('heading', { name: proposal.summary! }),
  })
  await review.getByRole('link', { name: 'Open source', exact: true }).click()
  expect(new URL(page.url()).searchParams.has('quoteStart')).toBe(true)
  const quoted = page.getByRole('region', { name: 'Exact cited passage' })
  await expect(quoted).toBeFocused()
  const passage = page.locator('.citation-evidence .markdown-preview p').filter({
    hasText: 'Exact evidence for the editorial change.',
  })
  await passage.selectText()
  await passage.dispatchEvent('pointerup')
  await page.getByRole('button', { name: 'Keep as evidence', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Keep as evidence', exact: true })).toContainText('Kept')
  await page.keyboard.press('Escape')
  const openResearch = async () => {
    const tab = page.getByRole('tab', { name: 'research', exact: true })
    if (!(await tab.isVisible()))
      await page.getByRole('button', { name: 'Open document inspector', exact: true }).click()
    await tab.click()
  }
  await openResearch()
  const evidence = page.getByRole('article', { name: `Evidence from ${source.title}` })
  await expect(evidence).toContainText(source.current_revision_id.slice(0, 8))
  await evidence.getByRole('button', { name: 'Source', exact: true }).click()
  await expect(page).toHaveURL(/text=.*&start=/)
  await expect(page.locator('.citation-evidence mark')).toHaveText('Exact evidence for the editorial change.')
  await page.reload()
  await expect(page.locator('.citation-evidence mark')).toHaveText('Exact evidence for the editorial change.')
  await page.getByRole('button', { name: 'Close cited revision' }).click()
  const cleared = new URL(page.url()).searchParams
  for (const key of ['revision', 'text', 'start', 'representation', 'quoteStart', 'quoteEnd'])
    expect(cleared.has(key)).toBe(false)
  await openResearch()
  await evidence.getByRole('button', { name: 'Ask', exact: true }).click()
  const composer = page.getByRole('textbox', { name: 'ChatKit composer' })
  await expect(composer).toBeVisible()
  await composer.fill('Explain this immutable cited passage.')
  const contextRequest = page.waitForRequest(
    (req) => req.url().endsWith('/api/v1/chat/contexts') && req.method() === 'POST',
  )
  const outgoing = page.waitForRequest(
    (req) => req.url().endsWith('/api/v1/chatkit') && req.method() === 'POST',
  )
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const context = z
    .object({
      document_id: z.string(),
      revision_id: z.string(),
      selected_text: z.string(),
    })
    .parse((await contextRequest).postDataJSON())
  expect(context).toEqual({
    document_id: source.document_id,
    revision_id: source.current_revision_id,
    selected_text: 'Exact evidence for the editorial change.',
  })
  expect((await outgoing).headers()['x-sangam-revision-id']).toBe(source.current_revision_id)
  await expect(page.getByRole('status').filter({ hasText: 'Message persisted' })).toBeVisible()
  const pending = await request.get(`/api/v1/chat/proposals?thread_id=${proposal.thread_id}`)
  expect(z.array(chatProposalSchema).parse(await pending.json())[0].status).toBe('pending')
})

test('concurrent document edit preserves reviewed wording and permits dismiss', async ({
  page,
  request,
  editorial,
}) => {
  const { proposal } = editorial
  await page.goto('/review')
  const card = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: proposal.summary! }) })
  await card.getByRole('button', { name: 'Edit wording' }).click()
  await card.getByLabel('Editable proposed wording').fill('Reviewer draft that must not be lost')
  await page.route(`**/chat/proposals/${proposal.proposal_id}/apply`, async (route) => {
    const changed = await request.patch(`/api/v1/documents/${proposal.document_id}`, {
      headers: { 'Idempotency-Key': randomUUID() },
      data: { expected_revision_id: proposal.expected_revision_id, content: 'Concurrent human update' },
    })
    expect(changed.ok()).toBeTruthy()
    await route.continue()
  })
  await card.getByRole('button', { name: 'Apply edited change' }).click()
  await expect(card.getByRole('alert').filter({ hasText: 'could not be applied' })).toBeVisible()
  await expect(card.getByLabel('Editable proposed wording')).toHaveValue(
    'Reviewer draft that must not be lost',
  )
  expect((await persisted(request, proposal.document_id)).content).toBe('Concurrent human update')
  await card.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(card).toHaveCount(0)
})

test('revision request prefills the actual ChatPanel and explicit Send persists outgoing feedback', async ({
  page,
  request,
  editorial,
}, testInfo) => {
  const { proposal } = editorial
  // Only the external ChatKit web component is replaced. All Sangam requests,
  // including turn creation and ChatKit message persistence, reach the real server.
  await page.route('https://cdn.platform.openai.com/deployments/chatkit/chatkit.js', (route) =>
    route.fulfill({
      path: path.resolve('e2e/chatkit-editorial-driver.js'),
      contentType: 'application/javascript',
    }),
  )
  await page.goto(`/documents/${proposal.document_id}`)
  await expect(page.getByRole('heading', { name: /^Crisp workspace/ })).toBeVisible()
  const sidebar = page.getByRole('button', { name: 'Show workspace sidebar' })
  if (await sidebar.isVisible()) await sidebar.click()
  await page.getByRole('link', { name: 'Review changes', exact: true }).click()
  const card = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: proposal.summary! }) })
  const trigger = card.getByRole('button', { name: 'Request a revision', exact: true })
  await trigger.focus()
  await page.keyboard.press('Enter')
  const feedback = card.getByLabel('What should be revised?')
  await expect(feedback).toBeFocused()
  await feedback.fill('Tighten the paragraph and keep the exact source quote.')
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await trigger.click()
  const advanced = await request.patch(`/api/v1/documents/${proposal.document_id}`, {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      expected_revision_id: proposal.expected_revision_id,
      content: 'Current draft changed while feedback was being written.',
    },
  })
  expect(advanced.ok()).toBeTruthy()
  const advancedDocument = documentSchema.parse(await advanced.json())
  await card.getByRole('button', { name: 'Prepare revision request in chat' }).click()
  await expect(page).toHaveURL(/\/chat\?/)
  const composer = page.getByRole('textbox', { name: 'ChatKit composer' })
  await expect(composer).toHaveValue(new RegExp(proposal.proposal_id))
  await expect(composer).toHaveValue(new RegExp(proposal.expected_revision_id))
  await expect(composer).toHaveValue(/Tighten the paragraph/)
  await expect(composer).toBeFocused()
  const composerBox = await composer.boundingBox()
  const viewportWidth = page.viewportSize()!.width
  const revealSidebar = page.getByRole('button', { name: 'Show workspace sidebar' })
  if (await revealSidebar.isVisible()) {
    const sidebarBox = await revealSidebar.boundingBox()
    const returnBox = await page.getByRole('button', { name: 'Return to document' }).boundingBox()
    expect(returnBox?.x).toBeGreaterThanOrEqual((sidebarBox?.x ?? 0) + (sidebarBox?.width ?? 0))
  }
  expect(composerBox?.width).toBeGreaterThan(viewportWidth / 2)
  expect((composerBox?.x ?? 0) + (composerBox?.width ?? 0)).toBeLessThanOrEqual(viewportWidth)
  await page
    .locator('openai-chatkit')
    .evaluate((host) =>
      host.dispatchEvent(new CustomEvent('chatkit.error', { detail: { message: 'Transport interrupted' } })),
    )
  await page.getByRole('button', { name: 'Retry workspace chat' }).click()
  await expect(composer).toHaveValue(new RegExp(proposal.proposal_id))
  await page.screenshot({
    path: testInfo.outputPath('editorial-feedback-composer.png'),
    fullPage: true,
    scale: 'css',
  })
  const pending = await request.get(`/api/v1/chat/proposals?thread_id=${proposal.thread_id}`)
  expect(z.array(chatProposalSchema).parse(await pending.json())[0].status).toBe('pending')
  const outgoing = page.waitForRequest(
    (req) => req.url().endsWith('/api/v1/chatkit') && req.method() === 'POST',
  )
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const sent = await outgoing
  const sentBody = z.object({ params: z.object({ thread_id: z.string() }) }).parse(sent.postDataJSON())
  expect(sentBody.params.thread_id).toBe(proposal.thread_id)
  expect(sent.postData()).toContain(proposal.proposal_id)
  expect(sent.postData()).toContain(proposal.expected_revision_id)
  expect(sent.postData()).toContain('Tighten the paragraph')
  expect(sent.headers()['x-sangam-revision-id']).toBe(advancedDocument.current_revision_id)
  expect(sent.postData()).toContain(proposal.thread_id)
  expect(sent.postData()).toContain("The agent's original proposed wording.")
  await expect(page.getByRole('status').filter({ hasText: 'Message persisted' })).toBeVisible()
  const items = await request.post('/api/v1/chatkit', {
    data: {
      type: 'items.list',
      params: { thread_id: proposal.thread_id, order: 'desc', limit: 20 },
    },
  })
  expect(items.ok(), await items.text()).toBeTruthy()
  expect(await items.text()).toContain('Tighten the paragraph')
  expect(await items.text()).toContain(proposal.proposal_id)
})

test('a deleted document context does not discard the revision feedback handoff', async ({
  page,
  request,
  editorial,
}) => {
  const { proposal } = editorial
  await page.route('https://cdn.platform.openai.com/deployments/chatkit/chatkit.js', (route) =>
    route.fulfill({
      path: path.resolve('e2e/chatkit-editorial-driver.js'),
      contentType: 'application/javascript',
    }),
  )
  await page.goto('/review')
  const card = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: proposal.summary! }) })
  await card.getByRole('button', { name: 'Request a revision', exact: true }).click()
  await card
    .getByLabel('What should be revised?')
    .fill('Keep this feedback after the document context fails.')
  const removed = await request.delete(`/api/v1/documents/${proposal.document_id}`, {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { expected_revision_id: proposal.expected_revision_id },
  })
  expect(removed.ok()).toBeTruthy()
  await card.getByRole('button', { name: 'Prepare revision request in chat' }).click()
  await expect(page.getByText('Document context could not be loaded')).toBeVisible()
  await page.getByRole('button', { name: 'Continue without document' }).click()
  const composer = page.getByRole('textbox', { name: 'ChatKit composer' })
  await expect(composer).toHaveValue(/Keep this feedback/)
  await expect(composer).toHaveValue(new RegExp(proposal.proposal_id))
  const sent = page.waitForRequest((req) => req.url().endsWith('/api/v1/chatkit') && req.method() === 'POST')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  expect((await sent).headers()['x-sangam-workspace-context']).toBe('1')
  await expect(page.getByRole('status').filter({ hasText: 'Message persisted' })).toBeVisible()
  const messages = await request.post('/api/v1/chatkit', {
    data: {
      type: 'items.list',
      params: { thread_id: proposal.thread_id, order: 'desc', limit: 20 },
    },
  })
  expect(await messages.text()).toContain('Keep this feedback')
  const listed = await request.get(`/api/v1/chat/proposals?thread_id=${proposal.thread_id}`)
  expect(z.array(chatProposalSchema).parse(await listed.json())[0].status).toBe('pending')
})

test('editorial layout contains controls at breakpoints and minimum width', async ({
  page,
  editorial,
}, testInfo) => {
  await page.goto('/review')
  const card = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: editorial.proposal.summary! }) })
  for (const width of [651, 649, 320, 844]) {
    await page.setViewportSize({ width, height: width === 844 ? 390 : 844 })
    await expect(page.locator('.workbench-shell')).toHaveCSS('width', `${width}px`)
    await card.getByRole('button', { name: 'Request a revision', exact: true }).click()
    await expect(card.getByLabel('What should be revised?')).toBeVisible()
    const dimensions = await page.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      scrollX,
      overflow: [...document.querySelectorAll('body *')]
        .filter(
          (element) =>
            element.getBoundingClientRect().right + scrollX > innerWidth + 1 ||
            element.scrollWidth > element.clientWidth + 1,
        )
        .map((element) => ({
          tag: element.tagName,
          className: element.className,
          right: element.getBoundingClientRect().right + scrollX,
          width: element.clientWidth,
          scroll: element.scrollWidth,
        }))
        .slice(0, 20),
    }))
    expect(dimensions.scrollWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.width)
    await card.getByRole('button', { name: 'Cancel', exact: true }).click()
    if (testInfo.project.name.includes('mobile')) {
      const box = await card.getByRole('button', { name: 'Apply change' }).boundingBox()
      expect(box?.height).toBeGreaterThanOrEqual(44)
    }
  }
})
