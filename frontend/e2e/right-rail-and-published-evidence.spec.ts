import { randomUUID } from 'node:crypto'

import { expect, test } from './fixtures'

async function createPublicationWithEvidence(request: import('@playwright/test').APIRequestContext) {
  const suffix = randomUUID().slice(0, 8)

  // 1. Source doc (public)
  const sourcePublicDoc = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      title: `Solar Benchmarking Report ${suffix}`,
      content:
        '# Solar Benchmarking Report\n\nPhotovoltaic efficiency improved by 14% across high-temperature test cycles.\n',
      content_type: 'text/markdown',
      path: `sources/public-${suffix}.md`,
    },
  })
  expect(sourcePublicDoc.ok(), await sourcePublicDoc.text()).toBeTruthy()
  // SAFETY: API response JSON contains document_id
  const sourcePublicData = (await sourcePublicDoc.json()) as { document_id: string }

  // Publish the source doc so it has an active publication slug
  const sourcePub = await request.post('/api/v1/publications', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      document_id: sourcePublicData.document_id,
      slug: `source-public-${suffix}`,
      access_policy: 'public',
    },
  })
  expect(sourcePub.ok(), await sourcePub.text()).toBeTruthy()

  // 2. Source doc (private workspace doc)
  const sourcePrivateDoc = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      title: `Private Internal Notes ${suffix}`,
      content:
        '# Internal Observations\n\nThermal dissipation models show stability up to 85 degrees Celsius.\n',
      content_type: 'text/markdown',
      path: `internal/notes-${suffix}.md`,
    },
  })
  expect(sourcePrivateDoc.ok(), await sourcePrivateDoc.text()).toBeTruthy()
  // SAFETY: API response JSON contains document_id
  const sourcePrivateData = (await sourcePrivateDoc.json()) as { document_id: string }

  // 3. Main synthesis doc
  const mainDoc = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      title: `Solar Research Synthesis ${suffix}`,
      content:
        '# Solar Research Synthesis\n\nRecent experimental trials demonstrated that photovoltaic efficiency improved by 14% across high-temperature test cycles.\n\nFurthermore, thermal dissipation models show stability up to 85 degrees Celsius in prolonged stress tests.\n',
      content_type: 'text/markdown',
      path: `research/synthesis-${suffix}.md`,
    },
  })
  expect(mainDoc.ok(), await mainDoc.text()).toBeTruthy()
  // SAFETY: API response JSON contains document_id
  const mainData = (await mainDoc.json()) as { document_id: string }

  // 4. Publish main doc with evidence items
  const mainPub = await request.post('/api/v1/publications', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      document_id: mainData.document_id,
      slug: `solar-synthesis-${suffix}`,
      access_policy: 'public',
      evidence: [
        {
          id: `ev-1-${suffix}`,
          source_document_id: sourcePublicData.document_id,
          source_title: 'Solar Benchmarking Report',
          selected_text: 'photovoltaic efficiency improved by 14% across high-temperature test cycles',
          claim: 'Solar cells show 14% efficiency gain in heat stress testing',
          note: 'Confirmed in 2025 benchmark',
        },
        {
          id: `ev-2-${suffix}`,
          source_document_id: sourcePrivateData.document_id,
          source_title: 'Private Internal Notes',
          selected_text: 'thermal dissipation models show stability up to 85 degrees Celsius',
          claim: 'Thermal stability holds up to 85C',
          note: 'Laboratory run #4',
        },
      ],
    },
  })
  expect(mainPub.ok(), await mainPub.text()).toBeTruthy()
  // SAFETY: API response JSON contains publication entity
  const pubData = (await mainPub.json()) as {
    publication_id: string
    document_id: string
    slug: string
  }
  return { mainData, pubData, suffix }
}

test('right rail presets answer the user question across writing, research, and review modes (#309)', async ({
  page,
  seededWorkspace,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop inspector presets')

  await page.goto(`/documents/${seededWorkspace.documentId}`)
  await expect(page.getByRole('heading', { name: seededWorkspace.documentTitle })).toBeVisible()

  // Open inspector if not already open
  const openInspector = page.getByRole('button', { name: 'Open document inspector', exact: true })
  if (await openInspector.isVisible()) {
    await openInspector.click()
  }

  const layoutsMenu = page.getByRole('button', { name: 'Workspace layouts', exact: true })
  await expect(layoutsMenu).toBeVisible()

  // 1. Click "Writing" preset
  await layoutsMenu.click()
  const writingPreset = page.getByRole('menuitem', { name: /Writing/i })
  await expect(writingPreset).toBeVisible()
  await writingPreset.click()

  // In Writing mode, right rail stays visible on Research tab (showing Project sources & notes)
  const researchTab = page.getByRole('tab', { name: 'research', exact: true })
  await expect(researchTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('radio', { name: 'edit', exact: true })).toBeChecked()
  await expect(page.locator('.document-sources-notes')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Sources and related notes' })).toBeVisible()

  // 2. Click "Research" preset
  await layoutsMenu.click()
  const researchPreset = page.getByRole('menuitem', { name: /Research/i })
  await expect(researchPreset).toBeVisible()
  await researchPreset.click()

  // In Research mode, editor is split and Research tab is active
  await expect(page.getByRole('radio', { name: 'split', exact: true })).toBeChecked()
  await expect(researchTab).toHaveAttribute('aria-selected', 'true')

  // 3. Click "Review" preset
  await layoutsMenu.click()
  const reviewPreset = page.getByRole('menuitem', { name: /Review/i })
  await expect(reviewPreset).toBeVisible()
  await reviewPreset.click()

  // In Review mode, editor is preview and History tab is active with review evidence
  await expect(page.getByRole('radio', { name: 'preview', exact: true })).toBeChecked()
  const historyTab = page.getByRole('tab', { name: 'history', exact: true })
  await expect(historyTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.review-evidence-section')).toBeVisible()
  await expect(page.getByText('Supporting evidence')).toBeVisible()
})

test('published evidence drawer allows readers to inspect citations and locate passages (#329)', async ({
  page,
  request,
}) => {
  const { pubData } = await createPublicationWithEvidence(request)

  await page.goto(`/p/${pubData.slug}`)
  await expect(page.getByRole('heading', { name: /Solar Research Synthesis/ }).first()).toBeVisible()

  // Header should show the Supporting Evidence toggle button with count badge 2
  const drawerToggle = page.locator('.evidence-drawer-toggle')
  await expect(drawerToggle).toBeVisible()
  await expect(drawerToggle).toContainText('Evidence')
  await expect(drawerToggle.locator('.evidence-badge')).toHaveText('2')

  // Open the drawer
  await drawerToggle.click()
  const drawer = page.locator('.publication-evidence-drawer')
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('heading', { name: 'Evidence Drawer' })).toBeVisible()

  // Check evidence cards
  const cards = drawer.locator('.drawer-evidence-card')
  await expect(cards).toHaveCount(2)

  // First card: public source has a public link to /p/source-public-...
  const publicLink = cards.first().locator('a.source-public-link')
  await expect(publicLink).toBeVisible()
  await expect(publicLink).toHaveAttribute('href', /\/p\/source-public-/)

  // Second card: private workspace source has Workspace source badge
  const privateBadge = cards.nth(1).locator('.source-private-badge')
  await expect(privateBadge).toBeVisible()
  await expect(privateBadge).toHaveText('Workspace source')

  // Find in text locator highlight
  const locateBtn = cards.first().getByRole('button', { name: 'Find in text' })
  await expect(locateBtn).toBeVisible()
  await locateBtn.click()

  // Verify the highlighted text received .evidence-highlight-pulse
  const highlighted = page.locator('.evidence-highlight-pulse')
  await expect(highlighted).toBeVisible()
  await expect(highlighted).toContainText('photovoltaic efficiency improved by 14%')

  // Search filter
  const searchInput = drawer.getByRole('searchbox', { name: 'Filter evidence' })
  if (await searchInput.isVisible()) {
    await searchInput.fill('Thermal stability')
    await expect(drawer.locator('.drawer-evidence-card')).toHaveCount(1)
    await expect(drawer.getByText('Thermal stability holds up to 85C')).toBeVisible()
    await searchInput.fill('')
    await expect(drawer.locator('.drawer-evidence-card')).toHaveCount(2)
  }

  // Close drawer
  const closeBtn = drawer.getByRole('button', { name: 'Close evidence drawer' })
  await closeBtn.click()
  await expect(drawer).not.toBeVisible()
})

test('capture multi-theme visual evidence for before/after comparison', async ({
  page,
  request,
}, testInfo) => {
  if (testInfo.project.name !== 'chromium-desktop') return

  const { pubData } = await createPublicationWithEvidence(request)

  // 1. Published evidence drawer across themes
  await page.goto(`/p/${pubData.slug}`)
  await expect(page.getByRole('heading', { name: /Solar Research Synthesis/ }).first()).toBeVisible()
  await page.locator('.evidence-drawer-toggle').click()
  await expect(page.locator('.publication-evidence-drawer')).toBeVisible()

  const themes = ['midnight', 'river', 'parchment', 'cobalt'] as const
  for (const theme of themes) {
    await page.evaluate((val) => document.documentElement.setAttribute('data-theme', val), theme)
    await page.waitForTimeout(100)
    await page.screenshot({
      path: testInfo.outputPath(`after-published-evidence-drawer-${theme}.png`),
    })
  }

  // 2. Right rail in Writing mode across themes
  await page.goto(`/documents/${pubData.document_id}`)
  const openInspector = page.getByRole('button', { name: 'Open document inspector', exact: true })
  if (await openInspector.isVisible()) {
    await openInspector.click()
  }
  const layoutsMenu = page.getByRole('button', { name: 'Workspace layouts', exact: true })
  await layoutsMenu.click()
  await page.getByRole('menuitem', { name: /Writing/i }).click()
  await expect(page.locator('.document-sources-notes')).toBeVisible()

  for (const theme of themes) {
    await page.evaluate((val) => document.documentElement.setAttribute('data-theme', val), theme)
    await page.waitForTimeout(100)
    await page.screenshot({
      path: testInfo.outputPath(`after-writing-preset-sources-notes-${theme}.png`),
    })
  }
})
