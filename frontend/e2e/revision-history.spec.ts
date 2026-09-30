import { randomUUID } from 'node:crypto'

import { expect, test } from './fixtures'
import { documentSchema } from '../src/api'

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
  const document = documentSchema.parse(await create.json())
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

test('older summary pages support exact preview and comparison', async ({ page, request }, testInfo) => {
  const created = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { title: `Paged history ${randomUUID()}`, content: 'Original oldest body' },
  })
  expect(created.ok()).toBeTruthy()
  let document = documentSchema.parse(await created.json())
  for (let index = 0; index < 21; index += 1) {
    const response = await request.patch(`/api/v1/documents/${document.document_id}`, {
      headers: { 'Idempotency-Key': randomUUID() },
      data: { expected_revision_id: document.current_revision_id, content: `New body ${index}` },
    })
    expect(response.ok()).toBeTruthy()
    document = documentSchema.parse(await response.json())
  }
  await page.goto(`/documents/${document.document_id}`)
  await page.getByRole('button', { name: 'Open document inspector' }).click()
  await page.getByRole('tab', { name: 'history', exact: true }).click()
  await expect(page.locator('.revision')).toHaveCount(20)
  await page.getByRole('button', { name: 'Load older revisions', exact: true }).click()
  await expect(page.locator('.revision')).toHaveCount(22)
  await expect(page.getByRole('button', { name: 'Load older revisions' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Preview', exact: true }).last().click()
  await expect(page.locator('.revision-render-preview')).toContainText('Original oldest body')
  await page.getByRole('button', { name: 'Compare', exact: true }).last().click()
  await expect(page.locator('.revision-render-preview')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close comparison', exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await testInfo.attach('paged-history', {
    body: await page.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  })
  await page.getByRole('button', { name: 'Close comparison', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Close comparison', exact: true })).toHaveCount(0)
})
