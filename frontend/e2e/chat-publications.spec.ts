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
