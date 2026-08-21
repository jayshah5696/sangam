import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { expect, test } from './fixtures'

const verifiedDir =
  '/Users/jshah/.gemini/antigravity/brain/420270f3-2dff-4a2c-b42b-918f852416c3/verified-mobile'

test.beforeAll(() => {
  if (!fs.existsSync(verifiedDir)) {
    fs.mkdirSync(verifiedDir, { recursive: true })
  }
})

test('capture verified mobile screenshots', async ({ page, request, seededWorkspace }) => {
  test.skip(page.viewportSize()?.width !== 390, 'narrow mobile viewport only')

  const repositoryRoot = path.resolve(import.meta.dirname, '../..')

  // 1. Create a second markdown document for tab bar verification
  const secondDocRes = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      title: 'Project Roadmap & Review',
      content:
        '# Roadmap\n\nSangam delivers local-first, privacy-respecting collaborative workspaces.\n\n## Milestones\n\n1. Native mobile touch ergonomics\n2. Responsive PDF research workspace\n3. High-fidelity isolated HTML rendering',
      content_type: 'text/markdown',
    },
  })
  const secondDoc = (await secondDocRes.json()) as { document_id: string }

  // 1. Document Workbench: verify tabs, title, and toolbar on mobile
  await page.goto(`/documents/${seededWorkspace.documentId}`)
  await expect(page.getByRole('heading', { name: seededWorkspace.documentTitle })).toBeVisible()

  // Open second document to show tabs
  await page.evaluate((id) => {
    window.location.href = `/documents/${id}`
  }, secondDoc.document_id)
  await expect(page.getByRole('heading', { name: 'Project Roadmap & Review' })).toBeVisible()
  await page.waitForTimeout(500)

  await page.screenshot({
    path: path.join(verifiedDir, 'verified-01-document-workbench.png'),
    fullPage: false,
  })

  // 2. Document Inspector Bottom Sheet: click mobile inspector button in toolbar
  const inspectorToggle = page.getByRole('button', { name: 'Open document inspector' })
  await expect(inspectorToggle).toBeVisible()
  await inspectorToggle.click()
  await page.waitForTimeout(400)
  await page.screenshot({
    path: path.join(verifiedDir, 'verified-02-document-inspector-sheet.png'),
    fullPage: false,
  })

  // 3. AI Chat inside Inspector Sheet
  const chatTab = page.getByRole('tab', { name: 'chat' })
  if (await chatTab.isVisible()) {
    await chatTab.click()
    await page.waitForTimeout(400)
    await page.screenshot({
      path: path.join(verifiedDir, 'verified-03-document-inspector-chat.png'),
      fullPage: false,
    })
  }

  // Close inspector
  const closeInspectorBtn = page.getByRole('button', { name: 'Collapse document inspector' })
  if (await closeInspectorBtn.isVisible()) {
    await closeInspectorBtn.click()
    await page.waitForTimeout(300)
  }

  // 4. Markdown Preview Mode
  await page.getByRole('radio', { name: 'preview' }).click()
  await page.waitForTimeout(400)
  await page.screenshot({
    path: path.join(verifiedDir, 'verified-04-document-preview-mode.png'),
    fullPage: false,
  })

  // 5. Interactive HTML Document Preview
  const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Sales Performance Dashboard</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; margin: 16px; background: #ffffff; color: #111827; }
    h2 { font-size: 1.15rem; margin-bottom: 6px; }
    p { font-size: 13px; color: #4b5563; margin-top: 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
    th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; }
    th { background: #f9fafb; font-weight: 600; }
    .badge { display: inline-block; padding: 2px 6px; border-radius: 99px; font-size: 10px; background: #dcfce7; color: #15803d; }
  </style>
</head>
<body>
  <h2>Quarterly Revenue & Accounts</h2>
  <p>Overview of verified business metrics and projections.</p>
  <table>
    <thead><tr><th>Region</th><th>Target</th><th>Actual</th><th>Status</th></tr></thead>
    <tbody>
      <tr><td>North America</td><td>$450k</td><td>$512k</td><td><span class="badge">Above Target</span></td></tr>
      <tr><td>EMEA</td><td>$320k</td><td>$345k</td><td><span class="badge">Above Target</span></td></tr>
      <tr><td>APAC</td><td>$210k</td><td>$198k</td><td><span class="badge">On Track</span></td></tr>
    </tbody>
  </table>
</body>
</html>`

  const htmlDocRes = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      title: 'Interactive Sales Dashboard',
      content: htmlContent,
      content_type: 'text/html',
    },
  })
  const htmlDoc = (await htmlDocRes.json()) as { document_id: string }

  await page.goto(`/documents/${htmlDoc.document_id}`)
  await expect(page.getByRole('heading', { name: 'Interactive Sales Dashboard' })).toBeVisible()
  await page.getByRole('radio', { name: 'preview' }).click()
  await page.waitForTimeout(500)
  await page.screenshot({
    path: path.join(verifiedDir, 'verified-05-html-preview.png'),
    fullPage: false,
  })

  // 6. PDF Research Workspace - Responsive Fit-to-Width & 1-Row Toolbar
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
      await page.waitForTimeout(1000)

      await page.screenshot({
        path: path.join(verifiedDir, 'verified-06-pdf-workspace-fit-width.png'),
        fullPage: false,
      })

      // 7. PDF Research Notes View Switcher
      const researchTabBtn = page.getByRole('tab', { name: /Research notes/ })
      if (await researchTabBtn.isVisible()) {
        await researchTabBtn.click()
        await page.waitForTimeout(400)
        await page.screenshot({
          path: path.join(verifiedDir, 'verified-07-pdf-research-notes-view.png'),
          fullPage: false,
        })
      }
    }
  }

  // 8. Command Palette on Mobile
  await page.goto('/')
  await page.keyboard.press('Meta+k')
  await page.waitForTimeout(300)
  await page.screenshot({
    path: path.join(verifiedDir, 'verified-08-command-palette.png'),
    fullPage: false,
  })
  await page.keyboard.press('Escape')

  // 9. Settings Appearance
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()
  await page.screenshot({
    path: path.join(verifiedDir, 'verified-09-settings-appearance.png'),
    fullPage: false,
  })

  // 10. Settings AI & Models
  await page.getByRole('button', { name: /AI & models/ }).click()
  await page.waitForTimeout(300)
  await page.screenshot({
    path: path.join(verifiedDir, 'verified-10-settings-models.png'),
    fullPage: false,
  })

  // 11. Settings Agents & Access
  await page.getByRole('button', { name: /Agents & access/ }).click()
  await page.waitForTimeout(300)
  await page.screenshot({
    path: path.join(verifiedDir, 'verified-11-settings-agents.png'),
    fullPage: false,
  })

  // 12. Welcome Screen
  await page.goto('/')
  await page.screenshot({
    path: path.join(verifiedDir, 'verified-12-welcome-page.png'),
    fullPage: false,
  })

  // 13. Activity Page
  await page.goto('/activity')
  await page.screenshot({
    path: path.join(verifiedDir, 'verified-13-activity-page.png'),
    fullPage: false,
  })

  // 14. Reconciliation Page
  await page.goto('/reconciliation')
  await page.screenshot({
    path: path.join(verifiedDir, 'verified-14-reconciliation-page.png'),
    fullPage: false,
  })

  // 15. Sidebar Drawer Open
  const showSidebarBtn = page.getByRole('button', { name: 'Show workspace sidebar' })
  if (await showSidebarBtn.isVisible()) {
    await showSidebarBtn.click()
    await expect(page.getByRole('dialog', { name: 'Workspace sidebar' })).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({
      path: path.join(verifiedDir, 'verified-15-sidebar-drawer.png'),
      fullPage: false,
    })
  }
})
