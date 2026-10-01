import { randomUUID } from 'node:crypto'
import { chatProposalSchema, documentSchema, projectDetailSchema } from '../src/api'
import { expect, test } from './fixtures'
import { z } from 'zod'

test('capture project and Home artifacts explicitly', async ({ page, request }) => {
  test.skip(process.env.SANGAM_CAPTURE_PROJECTS !== '1', 'Explicit artifact capture only')
  const draft = documentSchema.parse(
    await (
      await request.post('/api/v1/documents', {
        headers: { 'Idempotency-Key': randomUUID() },
        data: {
          title: 'Evaluation draft',
          content:
            '# Model comparison\n\nThe smaller model is enough for our local workload. We still need to check long-context retrieval.',
        },
      })
    ).json(),
  )
  const source = documentSchema.parse(
    await (
      await request.post('/api/v1/documents', {
        headers: { 'Idempotency-Key': randomUUID() },
        data: {
          title: 'Benchmark measurements',
          content: '# Measurements\n\nLatency and recall measurements from the evaluation run.',
        },
      })
    ).json(),
  )
  const project = projectDetailSchema.parse(
    await (
      await request.post('/api/v1/projects', {
        data: { name: 'Embedding comparison', description: 'Choose a model for the local machine.' },
      })
    ).json(),
  )
  try {
    for (const [doc, role] of [
      [draft, 'draft'],
      [source, 'source'],
    ] as const)
      await request.post(`/api/v1/projects/${project.project_id}/documents`, {
        data: { document_id: doc.document_id, role },
      })
    await page.goto('/')
    await page.getByLabel('Switch project').selectOption(project.project_id)
    await expect(page.getByRole('button', { name: 'Resume draft' })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: test.info().outputPath('home.png'), fullPage: true })
    await page.goto(`/projects?project=${project.project_id}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Embedding comparison' })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('project.png'), fullPage: true })
    await page.getByRole('button', { name: 'Add document', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByText('Loading available documents', { exact: true })).not.toBeVisible()
    await page.screenshot({ path: test.info().outputPath('attach-document.png') })
    await page.keyboard.press('Escape')
  } finally {
    await request.delete(`/api/v1/projects/${project.project_id}`)
  }
})

test('capture project review before and after explicitly', async ({ page, request }, testInfo) => {
  test.skip(process.env.SANGAM_CAPTURE_REVIEW !== '1', 'Explicit PR evidence capture only')
  const before = process.env.SANGAM_CAPTURE_BASE === '1'
  const createDocument = async (title: string, content: string) => {
    const response = await request.post('/api/v1/documents', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: { title, content },
    })
    expect(response.ok()).toBeTruthy()
    return documentSchema.parse(await response.json())
  }
  const draft = await createDocument(
    'Embedding recommendation',
    '# Embedding recommendation\n\nChoose MiniLM for CPU retrieval. The benchmark reports 12 ms per query.',
  )
  const source = await createDocument(
    'CPU benchmark notes',
    '# CPU benchmark notes\n\nMiniLM runs at 12 ms per query on the recorded CPU.\n\nLong-document retrieval was not measured.',
  )
  const project = projectDetailSchema.parse(
    await (await request.post('/api/v1/projects', { data: { name: 'CPU retrieval research' } })).json(),
  )
  for (const [doc, role] of [
    [draft, 'draft'],
    [source, 'source'],
  ] as const) {
    const response = await request.post(`/api/v1/projects/${project.project_id}/documents`, {
      data: { document_id: doc.document_id, role },
    })
    expect(response.ok()).toBeTruthy()
  }
  if (!before) {
    const response = await request.post(`/api/v1/projects/${project.project_id}/visits`, {
      headers: { 'Idempotency-Key': randomUUID() },
    })
    expect(response.ok()).toBeTruthy()
  }
  const threadResponse = await request.post('/api/v1/chatkit', {
    headers: { 'X-Sangam-Workspace-Context': '1' },
    data: {
      type: 'threads.create',
      params: {
        input: {
          content: [{ type: 'input_text', text: 'Review the recommendation' }],
          attachments: [],
          inference_options: { model: 'openai/gpt-5.4-nano' },
        },
      },
    },
  })
  const threadEvent = z.object({ type: z.literal('thread.created'), thread: z.object({ id: z.string() }) })
  const thread = (await threadResponse.text())
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => threadEvent.safeParse(JSON.parse(line.slice(6))))
    .find((result) => result.success)
  if (!thread?.success) throw new Error('Owner thread was not created')
  const fixture = z.object({ proposal: chatProposalSchema }).parse(
    await (
      await request.post('/__e2e/editorial', {
        data: { thread_id: thread.data.thread.id, document_id: draft.document_id },
      })
    ).json(),
  )
  for (const [doc, content] of [
    [
      source,
      '# CPU benchmark notes\n\nMiniLM runs at 20 ms per query on the recorded CPU.\n\nLong-document retrieval was not measured.',
    ],
    [
      draft,
      '# Embedding recommendation\n\nThe latest benchmark reports 20 ms per query.\n\nHuman note: preserve the CPU constraint and investigate long-document quality.',
    ],
  ] as const) {
    const response = await request.patch(`/api/v1/documents/${doc.document_id}`, {
      headers: { 'Idempotency-Key': randomUUID() },
      data: { expected_revision_id: doc.current_revision_id, content },
    })
    expect(response.ok()).toBeTruthy()
  }
  const capture = async (name: string) => {
    await page.evaluate(() => document.fonts.ready)
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true)
    await page.screenshot({
      path: testInfo.outputPath(name + '.png'),
      fullPage: true,
      animations: 'disabled',
      scale: 'css',
    })
  }
  await page.goto('/')
  await page.getByLabel('Switch project').selectOption(project.project_id)
  await expect(page.getByRole('button', { name: 'Resume draft' })).toBeVisible()
  await capture('home')
  if (!before) {
    await page.getByRole('region', { name: 'Since your last visit' }).screenshot({
      path: testInfo.outputPath('briefing.png'),
      animations: 'disabled',
      scale: 'css',
    })
    await page
      .getByRole('region', { name: 'Project reviews' })
      .getByRole('button', { name: 'Start review' })
      .click()
    const dialog = page.getByRole('dialog', { name: 'Start review' })
    await expect(dialog.getByRole('button', { name: 'Start review', exact: true })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({
      path: testInfo.outputPath('review-assignment.png'),
      animations: 'disabled',
      scale: 'css',
    })
    await dialog.getByRole('button', { name: 'Cancel' }).click()
  }
  await page.goto('/review')
  const card = page.locator('.review-card').filter({ hasText: draft.title })
  await expect(card).toContainText("The agent's original proposed wording.")
  await card.getByRole('button', { name: 'Request a revision', exact: true }).click()
  await card
    .getByLabel('What should be revised?')
    .fill('Preserve the human CPU constraint and use the latest evidence.')
  await capture('stale-proposal')
  if (!before) {
    await card.getByRole('button', { name: 'Compare edits' }).click()
    await expect(card.getByRole('region', { name: 'Edits since this proposal' })).toBeVisible()
    await capture('intervening-edits')
  }
  await request.post(`/api/v1/chat/proposals/${fixture.proposal.proposal_id}/dismiss`, {
    data: { reason: 'Evidence capture complete' },
  })
})
