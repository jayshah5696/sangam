import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures'

test('capture pr-355 visual evidence', async ({ page, request, seededWorkspace }) => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../..')
  const isNarrow = page.viewportSize()?.width === 390
  const suffix = randomUUID().slice(0, 8)

  // Seed another document that links to seededWorkspace to demonstrate backlinks
  const referringDoc = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      title: `Architecture Overview ${suffix}`,
      path: `docs/architecture-rfc-${suffix}.md`,
      content: `# RFC Discussion\n\nThis architecture links to [${seededWorkspace.documentTitle}](sangam://document/${seededWorkspace.documentId}) for review decisions.`,
      content_type: 'text/markdown',
    },
  })
  expect(referringDoc.ok()).toBeTruthy()

  await page.goto(`/documents/${seededWorkspace.documentId}`)
  await expect(page.getByRole('textbox', { name: 'Document title' })).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(500)

  if (isNarrow) {
    await page.screenshot({
      path: path.join(repositoryRoot, 'docs/assets/pr-355/after-document-workbench-narrow.png'),
      fullPage: false,
    })
    return
  }

  // 1. Desktop workbench with streamlined header & location pill
  await page.screenshot({
    path: path.join(repositoryRoot, 'docs/assets/pr-355/after-document-workbench-desktop.png'),
    fullPage: false,
  })

  // 2. Open Document Location Popover
  const locationButton = page.getByRole('button', { name: /Saved draft|Workspace location/ })
  await expect(locationButton).toBeVisible()
  await locationButton.click()
  await expect(page.getByRole('dialog', { name: /Draft location|Workspace location/ })).toBeVisible()
  await page.waitForTimeout(300)
  await page.screenshot({
    path: path.join(repositoryRoot, 'docs/assets/pr-355/after-document-location-popover.png'),
    fullPage: false,
  })

  // Close popover
  await page.keyboard.press('Escape')

  // 3. Open Inspector and view Backlinks under properties
  const inspectorToggle = page.getByRole('button', { name: 'Open document inspector' })
  if (await inspectorToggle.isVisible()) {
    await inspectorToggle.click()
    const propertiesTab = page.getByRole('tab', { name: /properties/i })
    await expect(propertiesTab).toBeVisible()
    await propertiesTab.click()
    await expect(page.getByRole('heading', { name: /Backlinks/i })).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(500)
    await page.screenshot({
      path: path.join(repositoryRoot, 'docs/assets/pr-355/after-document-backlinks-inspector.png'),
      fullPage: false,
    })
  }
})
