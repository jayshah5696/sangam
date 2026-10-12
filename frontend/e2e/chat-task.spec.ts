import { expect, test } from './fixtures'
import { z } from 'zod'

test('active task stays in context; corrections retain drafts and restore focus', async ({
  page,
  request,
}) => {
  const created = await request.post('/api/v1/chatkit', {
    data: {
      type: 'threads.create',
      params: {
        input: {
          content: [{ type: 'input_text', text: 'Plan the launch brief' }],
          attachments: [],
          inference_options: { model: 'openai/gpt-5.4-nano' },
        },
      },
    },
  })
  expect(created.ok()).toBeTruthy()
  const threadEvent = z.object({ type: z.literal('thread.created'), thread: z.object({ id: z.string() }) })
  const event = (await created.text())
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => threadEvent.safeParse(JSON.parse(line.slice(6))))
    .find((result) => result.success)
  if (!event?.success) throw new Error('Owner thread was not created')
  const threadId = event.data.thread.id
  const task = {
    thread_id: threadId,
    version: 3,
    through_item_id: 'source',
    source_hashes: {},
    stale: false,
    run_status: 'cancelled',
    effects: [],
    notes: [
      {
        key: 'language',
        kind: 'constraint',
        text: 'Use French',
        source_item_ids: ['source'],
        corrected: false,
      },
      {
        key: 'length',
        kind: 'constraint',
        text: 'At most 300 words',
        source_item_ids: ['source'],
        corrected: false,
      },
    ],
  }
  await page.route(`**/api/v1/chat/threads/${threadId}/task`, async (route) => {
    if (route.request().method() === 'PUT') {
      // SAFETY: this browser test sends the task correction payload defined by the form.
      const body = route.request().postDataJSON() as { key: string; text: string; expected_version: number }
      expect(body.expected_version).toBe(task.version)
      task.notes = task.notes.map((note) =>
        note.key === body.key ? { ...note, text: body.text, corrected: true } : note,
      )
      task.version += 1
    }
    await route.fulfill({ json: task })
  })
  await page.route(`**/api/v1/chat/threads/${threadId}/messages/source*`, (route) =>
    route.fulfill({
      json: {
        entries: [
          {
            thread_id: threadId,
            item_id: 'source',
            role: 'user',
            text: 'Use French, at most 300 words',
            citation: `/chat?thread=${threadId}&message=source`,
            offset: 0,
            total_chars: 34,
            truncated: false,
          },
        ],
        has_more: false,
      },
    }),
  )
  await page.goto(`/chat?thread=${threadId}`)
  await expect(page.getByRole('paragraph').filter({ hasText: /^Use French$/ })).not.toBeVisible()
  await page.getByRole('button', { name: 'Instructions', exact: true }).click()
  await page.getByRole('tab', { name: 'Active task' }).click()
  await expect(page.getByRole('paragraph').filter({ hasText: /^Use French$/ })).toBeVisible()
  await expect(
    page.getByText('Interrupted. No work continues in the background.', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Correct language' }).click()
  await page.getByLabel('Correction for language').fill('Use English')
  await page.getByRole('button', { name: 'Close chat context' }).click()
  await expect(page.getByRole('button', { name: 'Instructions', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Instructions', exact: true }).click()
  await expect(page.getByLabel('Correction for language')).toHaveValue('Use English')
  await page.getByRole('button', { name: 'Save task correction' }).click()
  await expect(page.getByRole('button', { name: 'Correct language' })).toBeFocused()
  await expect(page.getByRole('paragraph').filter({ hasText: /^Use English$/ })).toBeVisible()
  await expect(page.getByRole('paragraph').filter({ hasText: /^At most 300 words$/ })).toBeVisible()
  await page.getByLabel('Sources for language').click()
  await page.getByRole('button', { name: 'Read source source' }).first().click()
  await expect(page.getByText('Use French, at most 300 words', { exact: true })).toBeVisible()
  for (const width of [320, 599, 601, 767, 769, 899, 901, 844]) {
    await page.setViewportSize({ width, height: width === 844 ? 390 : 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    await expect(page.getByRole('dialog')).toBeInViewport()
  }
  await page.screenshot({ path: test.info().outputPath('active-task.png') })
  await page.goto(`/chat?thread=${threadId}&message=source`)
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Active task' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('Use French, at most 300 words', { exact: true })).toBeVisible()
})
