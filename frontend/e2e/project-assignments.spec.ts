import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures'
import { documentSchema, projectDetailSchema } from '../src/api'
import { z } from 'zod'
import { chatProposalSchema } from '../src/api'
import AxeBuilder from '@axe-core/playwright'

test('project briefing records a visit and assignment controls survive reload', async ({
  page,
  request,
}, testInfo) => {
  const created = await request.post('/api/v1/projects', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { name: `Assignment ${randomUUID().slice(0, 8)}` },
  })
  expect(created.ok()).toBeTruthy()
  const project = projectDetailSchema.parse(await created.json())
  const sourceResponse = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { title: 'CPU evidence', content: 'CPU latency is 12 ms.' },
  })
  const source = documentSchema.parse(await sourceResponse.json())
  await request.post(`/api/v1/projects/${project.project_id}/documents`, {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { document_id: source.document_id, role: 'source' },
  })
  await request.post(`/api/v1/projects/${project.project_id}/visits`, {
    headers: { 'Idempotency-Key': randomUUID() },
  })
  await request.patch(`/api/v1/documents/${source.document_id}`, {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { expected_revision_id: source.current_revision_id, content: 'CPU latency is 20 ms.' },
  })
  await page.addInitScript((id) => localStorage.setItem('sangam.home-project', id), project.project_id)
  await page.goto('/')
  const briefing = page.getByRole('region', { name: 'Since you last worked here' })
  await expect(briefing).toContainText('Source changed')
  await expect(briefing.getByRole('link', { name: /CPU evidence/ })).toBeVisible()
  const accessibility = await new AxeBuilder({ page })
    .include('[aria-label="Since you last worked here"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()
  expect(accessibility.violations).toEqual([])
  await page.getByRole('button', { name: 'Mark this visit' }).click()
  await expect(briefing).toContainText('No recorded changes since your last visit')
  await page.getByRole('button', { name: 'Review project claims' }).click()
  await page.getByLabel('Review instructions').fill('Find unsupported CPU performance claims')
  await page.getByRole('button', { name: 'Start project review', exact: true }).click()
  const assignments = page.getByRole('region', { name: 'Project assignments' })
  await expect(assignments).toContainText('Find unsupported CPU performance claims')
  await expect(assignments).toContainText(/failed|completed/)
  await page.reload()
  await expect(assignments).toContainText('Find unsupported CPU performance claims')
  await assignments.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(assignments).toContainText('stopped')
  await expect(assignments.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: testInfo.outputPath('project-assignment.png'), animations: 'disabled' })
})

test('stale review shows intervening edits and starts a durable fresh candidate', async ({
  page,
  request,
  seededWorkspace,
}) => {
  // Fixture route seeds through the same proposal service as the model tools.
  const threadResponse = await request.post('/api/v1/chatkit', {
    headers: { 'X-Sangam-Workspace-Context': '1' },
    data: {
      type: 'threads.create',
      params: {
        input: {
          content: [{ type: 'input_text', text: 'Review' }],
          attachments: [],
          inference_options: { model: 'openai/gpt-5.4-nano' },
        },
      },
    },
  })
  const threadSchema = z.object({ type: z.literal('thread.created'), thread: z.object({ id: z.string() }) })
  const thread = (await threadResponse.text())
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => threadSchema.safeParse(JSON.parse(line.slice(6))))
    .find((item) => item.success)
  if (!thread?.success) throw new Error('Thread fixture missing')
  const seed = await request.post('/__e2e/editorial', {
    data: { thread_id: thread.data.thread.id, document_id: seededWorkspace.documentId },
  })
  expect(seed.ok(), await seed.text()).toBeTruthy()
  const fixture = z.object({ proposal: chatProposalSchema }).parse(await seed.json())
  const document = documentSchema.parse(
    await (await request.get(`/api/v1/documents/${fixture.proposal.document_id}`)).json(),
  )
  await request.patch(`/api/v1/documents/${document.document_id}`, {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { expected_revision_id: document.current_revision_id, content: 'New human evidence' },
  })
  await page.goto('/review')
  const card = page.locator('.review-card').filter({ hasText: document.title })
  await card.getByRole('button', { name: 'Compare intervening edits' }).click()
  await expect(card.getByRole('region', { name: 'Changes since this proposal' })).toBeVisible()
  await card.getByRole('button', { name: 'Request a revision', exact: true }).click()
  await card.getByLabel('What should be revised?').fill('Preserve the new evidence')
  await card.getByRole('button', { name: 'Generate fresh candidate' }).click()
  await expect(card).toContainText('Fresh candidate assignment')
  await expect(card.locator('.revision-merge-view').last()).toContainText(
    "The agent's original proposed wording.",
  )
  await request.post(`/api/v1/chat/proposals/${fixture.proposal.proposal_id}/dismiss`, {
    data: { reason: 'Fixture complete' },
  })
})
