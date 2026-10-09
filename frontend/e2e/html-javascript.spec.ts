import { randomUUID } from 'node:crypto'

import type { APIRequestContext } from '@playwright/test'

import { expect, test } from './fixtures'

const interactiveHtml = `<!doctype html>
<html><head><style>body{font-family:system-ui;padding:24px}#result{font-weight:700}</style></head>
<body><h1>Interactive HTML fixture</h1><p id="result">not run</p>
<script>
  document.getElementById('result').textContent = 'JavaScript ran';
  let parentBlocked = false;
  let storageBlocked = false;
  try { void parent.document.body; } catch { parentBlocked = true; }
  try { void localStorage.length; } catch { storageBlocked = true; }
  document.body.dataset.parentBlocked = String(parentBlocked);
  document.body.dataset.storageBlocked = String(storageBlocked);
</script></body></html>`

test('HTML JavaScript runs in the isolated workbench preview and can be disabled', async ({
  page,
  request,
}, testInfo) => {
  await enableHtmlJavascript(request)
  const document = await createHtml(request)
  await page.goto(`/documents/${document.document_id}`)
  await page.screenshot({ path: testInfo.outputPath('html-javascript-enabled.png') })

  const interactiveFrame = page.frameLocator('iframe[title="Interactive HTML preview"]')
  await expect(interactiveFrame.locator('#result')).toHaveText('JavaScript ran')
  await expect(page.locator('iframe[title="Interactive HTML preview"]')).toHaveAttribute(
    'sandbox',
    'allow-scripts',
  )
  await expect(interactiveFrame.locator('body')).toHaveAttribute('data-parent-blocked', 'true')
  await expect(interactiveFrame.locator('body')).toHaveAttribute('data-storage-blocked', 'true')

  await page.goto('/settings')
  const revealSettings = page.getByRole('button', { name: 'Show settings sidebar' })
  if (await revealSettings.isVisible()) await revealSettings.click()
  const search = page.getByRole('searchbox', { name: 'Search settings' })
  await search.fill('HTML JavaScript')
  await search.press('Enter')
  await expect(page.locator('#html-javascript')).toBeFocused()
  const toggle = page.getByRole('checkbox', { name: 'Enable HTML JavaScript' })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect(page.getByText('Disabled', { exact: true })).toBeVisible()

  await page.goto(`/documents/${document.document_id}`)
  const safeFrame = page.frameLocator('iframe[title="Safe HTML preview"]')
  await expect(safeFrame.locator('#result')).toHaveText('not run')
  await expect(page.locator('iframe[title="Safe HTML preview"]')).toHaveAttribute('sandbox', '')
  await expect(safeFrame.locator('script')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('html-javascript-disabled.png') })
})

test('interactive HTML publications use the isolated runtime', async ({ page, request }) => {
  await enableHtmlJavascript(request)
  const document = await createHtml(request)
  const slug = `html-javascript-${randomUUID().slice(0, 8)}`
  const publication = await request.post('/api/v1/publications', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { document_id: document.document_id, slug, access_policy: 'public' },
  })
  expect(publication.ok(), await publication.text()).toBeTruthy()

  await page.goto(`/p/${slug}`)
  const frame = page.frameLocator('iframe[title="Interactive HTML publication"]')
  await expect(frame.locator('#result')).toHaveText('JavaScript ran')
  await expect(page.locator('iframe[title="Interactive HTML publication"]')).toHaveAttribute(
    'sandbox',
    'allow-scripts',
  )
})

test('published HTML pages fill the full viewport without half-height clipping', async ({
  page,
  request,
}, testInfo) => {
  const document = await createHtml(request)
  const slug = `html-full-viewport-${randomUUID().slice(0, 8)}`
  const publication = await request.post('/api/v1/publications', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { document_id: document.document_id, slug, access_policy: 'public' },
  })
  expect(publication.ok(), await publication.text()).toBeTruthy()

  await page.goto(`/p/${slug}`)
  const pageContainer = page.locator('.html-publication-page')
  await expect(pageContainer).toBeVisible()

  const header = page.locator('.html-publication-page > header')
  const iframe = page.locator('.html-publication-page .html-preview')
  await expect(header).toBeVisible()
  await expect(iframe).toBeVisible()

  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)

  const { headerBox, iframeBox, pageBox } = await page.evaluate(() => {
    const pageEl = document.querySelector('.html-publication-page')!
    const headerEl = pageEl.querySelector('header')!
    const iframeEl = pageEl.querySelector('.html-preview')!
    return {
      headerBox: headerEl.getBoundingClientRect(),
      iframeBox: iframeEl.getBoundingClientRect(),
      pageBox: pageEl.getBoundingClientRect(),
    }
  })

  // On desktop (1440x900), header is ~124px, so iframe must fill ~774px, NOT be clamped to 620px
  if (testInfo.project.name === 'chromium-desktop') {
    expect(iframeBox.height).toBeGreaterThan(700)
  } else if (testInfo.project.name === 'chromium-touch-mobile') {
    expect(iframeBox.height).toBeGreaterThan(600)
  }

  // The iframe top must touch the header bottom with no vertical gap
  expect(Math.abs(iframeBox.y - (headerBox.y + headerBox.height))).toBeLessThanOrEqual(2)

  // The iframe bottom must touch the page container bottom
  expect(Math.abs(iframeBox.y + iframeBox.height - (pageBox.y + pageBox.height))).toBeLessThanOrEqual(4)

  // Combined height of header and iframe must fill the full page container
  expect(Math.abs(headerBox.height + iframeBox.height - pageBox.height)).toBeLessThanOrEqual(4)

  // Verify no page-level horizontal overflow
  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(horizontalOverflow).toBeLessThanOrEqual(1)

  await page.screenshot({ path: testInfo.outputPath('published-html-full-viewport.png') })
})

test('HTML JavaScript setting remains usable without horizontal overflow on touch mobile', async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-touch-mobile', 'touch-mobile project only')
  await enableHtmlJavascript(request)
  await page.goto('/settings?category=workbench&destination=html-javascript')
  await expect(page.locator('#html-javascript')).toBeFocused()
  await expect(page.getByRole('checkbox', { name: 'Enable HTML JavaScript' })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})

async function enableHtmlJavascript(request: APIRequestContext) {
  const response = await request.get('/api/v1/settings/html-javascript')
  expect(response.ok(), await response.text()).toBeTruthy()
  // SAFETY: GET /api/v1/settings/html-javascript returns settings payload with enabled and version
  const settings = (await response.json()) as { enabled: boolean; version: number }
  if (settings.enabled) return
  const enabled = await request.put('/api/v1/settings/html-javascript', {
    data: { expected_version: settings.version, enabled: true },
  })
  expect(enabled.ok(), await enabled.text()).toBeTruthy()
}

async function createHtml(request: APIRequestContext) {
  const response = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      title: `Interactive HTML ${randomUUID().slice(0, 8)}`,
      content: interactiveHtml,
      content_type: 'text/html',
    },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  // SAFETY: POST /api/v1/documents returns document entity with document_id and current_revision_id
  return (await response.json()) as { document_id: string; current_revision_id: string }
}
