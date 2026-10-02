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
