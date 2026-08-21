import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { expect, test } from './fixtures'

test('capture the README workspace and settings screenshots', async ({ page, request }) => {
  test.skip(!process.env.SANGAM_UPDATE_SCREENSHOTS, 'Run npm run update:screenshots to update docs assets')

  const repositoryRoot = path.resolve(import.meta.dirname, '../..')
  const narrow = page.viewportSize()?.width === 390

  if (narrow) {
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()
    await page.screenshot({
      path: path.join(repositoryRoot, 'docs/assets/crisp-settings-narrow.png'),
      fullPage: false,
    })
    return
  }

  const document = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      title: 'Product launch review',
      content:
        '# Product review\n\nSangam keeps document state, citations, and proposed changes visible.\n\n## Next decision\n\nReview the pending work before publishing.',
      content_type: 'text/markdown',
    },
  })
  expect(document.ok(), await document.text()).toBeTruthy()
  const payload = (await document.json()) as { document_id: string }

  await page.goto(`/documents/${payload.document_id}`)
  await expect(page.getByRole('heading', { name: 'Product launch review' })).toBeVisible()
  await page.screenshot({
    path: path.join(repositoryRoot, 'docs/assets/crisp-workspace.png'),
    fullPage: false,
  })

  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()
  await page.screenshot({
    path: path.join(repositoryRoot, 'docs/assets/crisp-settings.png'),
    fullPage: false,
  })
})
