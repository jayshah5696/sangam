import { randomUUID } from 'node:crypto'

import { expect, test } from './fixtures'

test('history loads revision summaries and fetches content only when preview is requested', async ({
  page,
  request,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const create = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { title: `History ${suffix}`, content: 'Older body' },
  })
  expect(create.ok(), await create.text()).toBeTruthy()
  // SAFETY: POST /api/v1/documents returns a document ID and current revision ID.
  const document = (await create.json()) as { document_id: string; current_revision_id: string }
  const revise = await request.patch(`/api/v1/documents/${document.document_id}`, {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { expected_revision_id: document.current_revision_id, content: 'Current body' },
  })
  expect(revise.ok(), await revise.text()).toBeTruthy()

  let summaryBody = ''
  const revisionRequests: string[] = []
  page.on('response', async (response) => {
    const url = new URL(response.url())
    if (!url.pathname.includes('/revisions')) return
    if (url.pathname.endsWith('/revisions')) summaryBody = await response.text()
    else revisionRequests.push(url.pathname)
  })

  await page.goto(`/documents/${document.document_id}`)
  await page.getByRole('button', { name: 'Open document inspector' }).click()
  const historyTab = page.getByRole('tab', { name: 'history' })
  await expect(historyTab).toBeVisible()
  await historyTab.click()

  await expect(page.getByRole('button', { name: 'Preview' }).first()).toBeVisible()
  await expect.poll(() => summaryBody).not.toBe('')
  expect(summaryBody).not.toContain('Older body')
  expect(revisionRequests).toEqual([])

  await page.getByRole('button', { name: 'Preview' }).last().click()
  await expect(page.getByText('Rendered revision')).toBeVisible()
  await expect(page.getByText('Older body')).toBeVisible()
  expect(revisionRequests).toContain(
    `/api/v1/documents/${document.document_id}/revisions/${document.current_revision_id}`,
  )
})
