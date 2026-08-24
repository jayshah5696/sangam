import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { expect, test } from './fixtures'

test('capture the README workspace and settings screenshots', async ({ page, request, seededWorkspace }) => {
  test.skip(!process.env.SANGAM_UPDATE_SCREENSHOTS, 'Run npm run update:screenshots to update docs assets')

  const repositoryRoot = path.resolve(import.meta.dirname, '../..')
  const narrow = page.viewportSize()?.width === 390

  if (narrow) {
    // 1. Mobile Document Workbench
    await page.goto(`/documents/${seededWorkspace.documentId}`)
    await expect(page.getByRole('heading', { name: seededWorkspace.documentTitle })).toBeVisible()
    await page.waitForTimeout(400)
    await page.screenshot({
      path: path.join(repositoryRoot, 'docs/assets/crisp-workspace-narrow.png'),
      fullPage: false,
    })

    // 2. Mobile Inspector Sheet
    const inspectorToggle = page.getByRole('button', { name: 'Open document inspector' })
    if (await inspectorToggle.isVisible()) {
      await inspectorToggle.click()
      await page.waitForTimeout(400)
      await page.screenshot({
        path: path.join(repositoryRoot, 'docs/assets/crisp-inspector-narrow.png'),
        fullPage: false,
      })

      // 3. Mobile AI Chat Tab inside Inspector
      const chatTab = page.getByRole('tab', { name: 'chat' })
      if (await chatTab.isVisible()) {
        await chatTab.click()
        const chatFrame = page.locator('openai-chatkit iframe')
        await expect(chatFrame).toBeVisible({ timeout: 15_000 })
        await expect(
          page
            .frameLocator('openai-chatkit iframe')
            .getByRole('heading', { name: 'Ask about this workspace' }),
        ).toBeVisible({ timeout: 15_000 })
        await page.screenshot({
          path: path.join(repositoryRoot, 'docs/assets/crisp-chat-narrow.png'),
          fullPage: false,
        })
      }
    }

    // 4. Mobile Settings
    await page.goto('/settings?category=appearance')
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()
    await page.screenshot({
      path: path.join(repositoryRoot, 'docs/assets/crisp-settings-narrow.png'),
      fullPage: false,
    })

    // 5. Mobile PDF Research Workspace
    const samplePdfPath = path.join(repositoryRoot, 'data/workspace/research/architecture.pdf')
    if (fs.existsSync(samplePdfPath)) {
      const pdfBuffer = fs.readFileSync(samplePdfPath)
      const pdfUploadRes = await request.post(
        '/api/v1/pdfs?title=Architecture%20Research&path=research/architecture.pdf',
        {
          headers: {
            'Content-Type': 'application/pdf',
            'Idempotency-Key': randomUUID(),
          },
          data: pdfBuffer,
        },
      )
      if (pdfUploadRes.ok()) {
        const pdfDoc = (await pdfUploadRes.json()) as { document_id: string }
        await page.goto(`/documents/${pdfDoc.document_id}`)
        await expect(page.getByRole('heading', { name: 'Architecture Research' })).toBeVisible()
        await page.waitForTimeout(800)
        await page.screenshot({
          path: path.join(repositoryRoot, 'docs/assets/phase-5-pdf-research-narrow.png'),
          fullPage: false,
        })
      }
    }

    // 6. Mobile HTML Preview
    const htmlDocRes = await request.post('/api/v1/documents', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: {
        title: 'Interactive Sales Dashboard',
        content: `<!DOCTYPE html>
<html>
<head><style>body { font-family: -apple-system, system-ui, sans-serif; padding: 16px; color: #111827; } h2 { font-size: 1.15rem; margin-bottom: 6px; } table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; } th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; } th { background: #f9fafb; font-weight: 600; } .badge { display: inline-block; padding: 2px 6px; border-radius: 99px; font-size: 10px; background: #dcfce7; color: #15803d; }</style></head>
<body><h2>Quarterly Revenue</h2><table><thead><tr><th>Region</th><th>Target</th><th>Actual</th></tr></thead><tbody><tr><td>North America</td><td>$450k</td><td>$512k</td></tr><tr><td>EMEA</td><td>$320k</td><td>$345k</td></tr></tbody></table></body></html>`,
        content_type: 'text/html',
      },
    })
    if (htmlDocRes.ok()) {
      const htmlDoc = (await htmlDocRes.json()) as { document_id: string }
      await page.goto(`/documents/${htmlDoc.document_id}`)
      await expect(page.getByRole('heading', { name: 'Interactive Sales Dashboard' })).toBeVisible()
      await page.getByRole('radio', { name: 'preview' }).click()
      await page.waitForTimeout(500)
      await page.screenshot({
        path: path.join(repositoryRoot, 'docs/assets/phase-4-publishing-narrow.png'),
        fullPage: false,
      })
    }

    return
  }

  // Desktop captures
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
  await page.waitForTimeout(400)
  await page.screenshot({
    path: path.join(repositoryRoot, 'docs/assets/crisp-workspace.png'),
    fullPage: false,
  })

  // Document chat expands from the inspector into the full conversation route.
  await page.getByRole('tab', { name: 'chat', exact: true }).click()
  await page.getByRole('button', { name: 'Open full chat' }).click()
  await expect(page.getByRole('heading', { name: 'Workspace chat' })).toBeVisible()
  await expect(page.getByLabel('Active chat context')).toContainText('Product launch review')
  const fullChat = page.locator('.chat-panel:not(.chat-panel-compact)')
  const fullChatFrame = fullChat.locator('openai-chatkit iframe')
  await expect(fullChatFrame).toBeVisible({ timeout: 15_000 })
  await expect(
    fullChat.frameLocator('openai-chatkit iframe').getByRole('heading', { name: 'Ask about this workspace' }),
  ).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(400)
  await page.screenshot({
    path: path.join(repositoryRoot, 'docs/assets/crisp-chat.png'),
    fullPage: false,
  })

  await page.goto('/settings?category=agents')
  await expect(page.getByRole('heading', { name: 'Agents & access', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/category=agents/)
  await page.getByText('Custom capabilities and workspace boundaries').click()
  await page.getByRole('checkbox', { name: 'publish' }).click()
  await page.getByRole('button', { name: 'Issue token' }).click()
  await expect(
    page.getByText('Confirm the high-impact capabilities before issuing this token.'),
  ).toBeVisible()
  await page.screenshot({
    path: path.join(repositoryRoot, 'docs/assets/crisp-settings.png'),
    fullPage: false,
  })
})
