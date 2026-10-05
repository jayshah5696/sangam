import { randomUUID } from 'node:crypto'
import type { Page, TestInfo } from '@playwright/test'
import { z } from 'zod'

import { expect, openIfClosed, test as base } from './fixtures'

const documentIdentity = z.object({ document_id: z.string() })
const htmlPolicy = z.object({ enabled: z.boolean(), version: z.number().int() })
const test = base.extend<{ htmlJavascriptEnabled: boolean }>({
  htmlJavascriptEnabled: async ({ request, browserName }, runFixture) => {
    const response = await request.get('/api/v1/settings/html-javascript')
    expect(response.ok(), await response.text()).toBeTruthy()
    const original = htmlPolicy.parse(await response.json())
    // The existing isolated preview host is blocked by WebKit's CSP handling.
    // Exercise the real safe-preview policy there without relaxing its sandbox.
    const enabled = browserName !== 'webkit'
    if (enabled !== original.enabled) {
      const changed = await request.put('/api/v1/settings/html-javascript', {
        data: { enabled, expected_version: original.version },
      })
      expect(changed.ok(), await changed.text()).toBeTruthy()
    }
    try {
      await runFixture(enabled)
    } finally {
      if (enabled !== original.enabled) {
        const current = htmlPolicy.parse(await (await request.get('/api/v1/settings/html-javascript')).json())
        const restored = await request.put('/api/v1/settings/html-javascript', {
          data: { enabled: original.enabled, expected_version: current.version },
        })
        expect(restored.ok(), await restored.text()).toBeTruthy()
      }
    }
  },
})
const article = `<!doctype html><html><head><style>
  body { margin: 0; padding: 32px; background: #f7f5ef; color: #23382e; font: 16px/1.7 system-ui; }
  h1 { font-size: 30px; line-height: 1.2; } h2 { font-size: 20px; }
  section { border-top: 1px solid #c7d1c9; padding: 16px 0; }
</style></head><body><h1>Workspace field notes</h1><p>A practical guide to keeping drafts and sources together.</p>
${Array.from({ length: 12 }, (_, index) => `<section><h2>Note ${index + 1}</h2><p>Keep the draft readable and record the sources behind each decision. Review changes before publishing and retain the original evidence.</p></section>`).join('')}
</body></html>`

async function revealSidebar(page: Page) {
  await openIfClosed(
    page.getByRole('button', { name: /^Show (workspace|settings) sidebar$/ }),
    page.getByRole('link', { name: 'Sangam home', exact: true }),
  )
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), animations: 'disabled', scale: 'css' })
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1)
}

test('HTML preview keeps collapsed source text compact and expanded text scrollable', async ({
  page,
  request,
  htmlJavascriptEnabled,
}, testInfo) => {
  const response = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { title: 'Workspace field notes', content: article, content_type: 'text/html' },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  const document = documentIdentity.parse(await response.json())
  await page.goto(`/documents/${document.document_id}`)
  const surface = page.locator('.editing-surface')
  const preview = surface.locator('.html-preview')
  const sourceText = surface.locator('.html-source-text')
  const summary = sourceText.locator('summary')
  await expect(preview).toBeVisible()
  await expect(preview).toHaveAttribute(
    'title',
    htmlJavascriptEnabled ? 'Interactive HTML preview' : 'Safe HTML preview',
  )
  await expect(
    page.frameLocator('.html-preview').getByRole('heading', { name: 'Workspace field notes', exact: true }),
  ).toBeVisible()
  await expect(sourceText).not.toHaveAttribute('open', '')
  await capture(page, testInfo, 'html-preview-collapsed')

  const collapsed = await sourceText.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      height: element.getBoundingClientRect().height,
      naturalHeight:
        element.querySelector('summary')!.getBoundingClientRect().height +
        Number.parseFloat(style.paddingTop) +
        Number.parseFloat(style.paddingBottom),
    }
  })
  expect(collapsed.height).toBeLessThanOrEqual(collapsed.naturalHeight + 2)
  expect((await preview.boundingBox())!.height).toBeGreaterThan((await surface.boundingBox())!.height * 0.7)

  await summary.click()
  await expect(sourceText).toHaveAttribute('open', '')
  await capture(page, testInfo, 'html-preview-expanded')
  expect((await preview.boundingBox())!.height).toBeGreaterThan((await surface.boundingBox())!.height * 0.5)
  expect(await sourceText.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(
    0,
  )
  await sourceText.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect(sourceText.locator('p').last()).toBeInViewport()
  await sourceText.evaluate((element) => {
    element.scrollTop = 0
  })
  await summary.click()
  await expect(sourceText).not.toHaveAttribute('open', '')
  await expectNoHorizontalOverflow(page)

  if (page.viewportSize()!.width > 900) {
    await page.getByRole('radio', { name: 'split', exact: true }).click()
    await expect(surface.locator('.cm-editor')).toBeVisible()
    const editorBox = (await surface.locator('.editor').boundingBox())!
    const previewBox = (await preview.boundingBox())!
    expect(previewBox.y).toBeCloseTo(editorBox.y, 0)
    expect(previewBox.height).toBeCloseTo(editorBox.height, 0)
    const sourceBox = (await sourceText.boundingBox())!
    expect(sourceBox.y).toBeGreaterThanOrEqual(previewBox.y + previewBox.height - 1)
    expect(sourceBox.width).toBeCloseTo((await surface.boundingBox())!.width, 0)
    await capture(page, testInfo, 'html-split-collapsed')
    await page.getByRole('radio', { name: 'preview', exact: true }).click()
    await expect(surface.locator('.cm-editor')).toHaveCount(0)
  }

  const sizes =
    testInfo.project.name === 'chromium-desktop'
      ? [
          { width: 901, height: 900 },
          { width: 899, height: 900 },
          { width: 320, height: 568 },
          { width: 844, height: 390 },
        ]
      : [{ width: 844, height: 390 }]
  for (const size of sizes) {
    await page.setViewportSize(size)
    await expect(preview).toBeVisible()
    await expect
      .poll(async () => {
        const box = (await sourceText.boundingBox())!
        return box.y + box.height
      })
      .toBeLessThanOrEqual(size.height + 1)
    const textBox = (await sourceText.boundingBox())!
    const frameBox = (await preview.boundingBox())!
    expect(textBox.y).toBeGreaterThanOrEqual(frameBox.y + frameBox.height - 1)
    expect(textBox.y + textBox.height).toBeLessThanOrEqual(size.height + 1)
    await expectNoHorizontalOverflow(page)
  }
})

test('Files has one search entry and Search returns cleanly to Files', async ({ page }, testInfo) => {
  await page.goto('/')
  await revealSidebar(page)
  await expect(page.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute('aria-selected', 'true')
  await capture(page, testInfo, 'sidebar-files')
  await expect(page.getByRole('button', { name: 'Search workspace', exact: true })).toHaveCount(0)
  await page.getByRole('tab', { name: 'Search', exact: true }).click()
  await expect(page.getByRole('searchbox', { name: 'Search documents', exact: true })).toBeFocused()
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New file', exact: true })).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

for (const destination of [
  { route: '/reconciliation', action: 'Review conflicts', heading: 'Reconciliation' },
  { route: '/backups', action: 'Manage backups', heading: 'Backups' },
  { route: '/karakeep', action: 'Manage imports', heading: 'Karakeep imports' },
]) {
  test(`Operations keeps Settings navigation on ${destination.route} and returns to the workspace`, async ({
    page,
  }, testInfo) => {
    await page.goto('/publications')
    await revealSidebar(page)
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await revealSidebar(page)
    await page.getByRole('button', { name: /^Operations/ }).click()
    const action = page.getByRole('link', { name: destination.action, exact: true })
    // Imports is conditional on a configured integration; its direct URL remains valid.
    if (destination.route === '/karakeep' && !(await action.isVisible())) await page.goto(destination.route)
    else await action.click()
    await expect(page.getByRole('heading', { name: destination.heading, exact: true })).toBeVisible()
    await revealSidebar(page)
    await capture(page, testInfo, `operations-${destination.route.slice(1)}`)
    await expect(page.getByRole('navigation', { name: 'Settings pages' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Operations/ })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('tab', { name: 'Files', exact: true })).toHaveCount(0)
    await expectNoHorizontalOverflow(page)
    await page.reload()
    await revealSidebar(page)
    await expect(page.getByRole('button', { name: /^Operations/ })).toHaveAttribute('aria-current', 'page')
    await page.getByRole('button', { name: 'Back to workspace', exact: true }).click()
    await expect(page).toHaveURL(/\/publications$/)
    await page.goto(destination.route)
    await page.locator('body').press('Escape')
    await expect(page).toHaveURL(/\/publications$/)
  })
}

test('Operations rail stays correct on both sides of the sidebar breakpoint', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'fine-pointer breakpoint coverage')
  for (const width of [1101, 1099, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/backups')
    await revealSidebar(page)
    await expect(page.getByRole('navigation', { name: 'Settings pages' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Operations/ })).toHaveAttribute('aria-current', 'page')
    await expectNoHorizontalOverflow(page)
  }
})

test('mobile treats split workbench as single surface switcher with companion bar (Issue 312)', async ({
  page,
  request,
  seededWorkspace,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-touch-mobile', 'touch-mobile validation')

  // Create a second document (source)
  const sourceResponse = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      title: 'Research Source Note',
      content: '# Research Findings\n\nDirect evidence from the initial interview.',
      content_type: 'text/markdown',
      path: 'sources/findings.md',
    },
  })
  expect(sourceResponse.ok(), await sourceResponse.text()).toBeTruthy()
  // SAFETY: POST /api/v1/documents returns document entity containing document_id
  const sourceData = (await sourceResponse.json()) as { document_id: string }

  // Seed localStorage workbench layout before navigation
  await page.addInitScript(
    ({ draftId, sourceId }) => {
      localStorage.setItem(
        'sangam.workbench.v1',
        JSON.stringify({
          schemaVersion: 1,
          activeGroupId: 'group-1',
          root: {
            kind: 'split',
            id: 'split-root',
            direction: 'horizontal',
            ratio: 50,
            first: {
              kind: 'group',
              id: 'group-1',
              activeTabId: draftId,
              tabs: [{ documentId: draftId, title: 'Crisp workspace', pinned: false }],
            },
            second: {
              kind: 'group',
              id: 'group-2',
              activeTabId: sourceId,
              tabs: [{ documentId: sourceId, title: 'Research Source Note', pinned: false }],
            },
          },
        }),
      )
    },
    { draftId: seededWorkspace.documentId, sourceId: sourceData.document_id },
  )

  await page.goto(`/documents/${seededWorkspace.documentId}`)

  // Capture "before" state (simulating workbench without mobile surface switcher and companion bar)
  await page.evaluate(() => {
    document.querySelector('.mobile-surface-switcher')?.setAttribute('style', 'display: none !important')
    document.querySelector('.mobile-companion-bar')?.setAttribute('style', 'display: none !important')
  })
  await capture(page, testInfo, 'mobile-312-before')
  await page.screenshot({
    path: '/home/jshah/.t3/userdata/providers/antigravity/ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32/antigravity-acp/brain/6cd1d6de-e226-4928-97b8-44433ac1f595/mobile-before.png',
    animations: 'disabled',
    scale: 'css',
  })
  await page.evaluate(() => {
    document.querySelector('.mobile-surface-switcher')?.removeAttribute('style')
    document.querySelector('.mobile-companion-bar')?.removeAttribute('style')
  })

  // Verify surface switcher is visible with role="tablist"
  const switcher = page.getByRole('tablist', { name: 'Working surfaces' })
  await expect(switcher).toBeVisible()

  // Verify tabs
  const tabs = switcher.getByRole('tab')
  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'false')

  // Verify companion bar
  const companionBar = page.getByRole('region', { name: 'Connected companion surface' })
  await expect(companionBar).toBeVisible()
  const companionButton = companionBar.getByRole('button')
  await expect(companionButton).toContainText('Switch to source:')

  // Capture "after" state on draft surface
  await capture(page, testInfo, 'mobile-312-after-draft')
  await page.screenshot({
    path: '/home/jshah/.t3/userdata/providers/antigravity/ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32/antigravity-acp/brain/6cd1d6de-e226-4928-97b8-44433ac1f595/mobile-after-draft.png',
    animations: 'disabled',
    scale: 'css',
  })

  // Tap second tab in switcher -> switches to source
  await tabs.nth(1).click()
  await expect(page).toHaveURL(new RegExp(`/documents/${sourceData.document_id}`))
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'false')

  // Verify companion button on source now offers to switch to draft
  await expect(companionBar.getByRole('button')).toContainText('Switch to draft:')

  // Capture "after" state on source surface
  await capture(page, testInfo, 'mobile-312-after-source')
  await page.screenshot({
    path: '/home/jshah/.t3/userdata/providers/antigravity/ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32/antigravity-acp/brain/6cd1d6de-e226-4928-97b8-44433ac1f595/mobile-after-source.png',
    animations: 'disabled',
    scale: 'css',
  })

  // Tap companion button -> switches back to draft
  await companionBar.getByRole('button').click()
  await expect(page).toHaveURL(new RegExp(`/documents/${seededWorkspace.documentId}`))
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
})
