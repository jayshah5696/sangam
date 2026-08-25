import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { expect, test } from './fixtures'

async function importSamplePdf(
  request: import('@playwright/test').APIRequestContext,
  sourcePath = process.env.SANGAM_PDF_EVIDENCE_SOURCE ??
    path.join(import.meta.dirname, 'assets/multipage.pdf'),
) {
  const source = fs.readFileSync(sourcePath)
  const response = await request.post(
    `/api/v1/pdfs?title=PDF%20reader%20evidence&path=research/reader-${randomUUID()}.pdf`,
    {
      headers: { 'Content-Type': 'application/pdf', 'Idempotency-Key': randomUUID() },
      data: source,
    },
  )
  expect(response.ok(), await response.text()).toBeTruthy()
  return (await response.json()) as { document_id: string }
}

async function createAnnotation(
  request: import('@playwright/test').APIRequestContext,
  documentId: string,
  input: Record<string, unknown>,
) {
  const response = await request.post(`/api/v1/pdfs/${documentId}/annotations`, {
    headers: { 'Idempotency-Key': randomUUID() },
    data: input,
  })
  expect(response.ok(), await response.text()).toBeTruthy()
}

test('PDF reader uses one research inspector without starving the page', async ({ page, request }) => {
  test.skip(page.viewportSize()?.width !== 1440, 'desktop project only')
  const document = await importSamplePdf(request)
  await page.goto(`/documents/${document.document_id}`)
  await expect(page.getByRole('heading', { name: 'PDF reader evidence' })).toBeVisible()
  await expect(page.locator('.pdf-page').first()).toBeVisible()
  await expect(page.locator('.pdf-research-rail')).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'research' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Fit PDF to width' })).toBeVisible()
  const readerWidth = await page.locator('.pdf-reader').evaluate((element) => element.clientWidth)
  expect(readerWidth).toBeGreaterThan(550)

  await page.getByRole('tab', { name: 'research' }).click()
  await expect(page.getByRole('region', { name: 'PDF research' })).toBeVisible()
  await expect(page.getByRole('toolbar', { name: 'Add PDF annotation' })).toBeVisible()
  await expect(page.getByText('Replacement PDF')).toHaveCount(0)
  await page.getByRole('tab', { name: 'properties' }).click()
  await expect(page.getByText('Replacement PDF')).toBeVisible()

  const evidenceDir = process.env.SANGAM_EVIDENCE_DIR
  if (evidenceDir) {
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(evidenceDir, 'pdf-reader.png'), fullPage: false })
  }
})

test('PDF highlights and long quotes use the research inspector hierarchy', async ({ page, request }) => {
  test.skip(page.viewportSize()?.width !== 1440, 'desktop project only')
  const document = await importSamplePdf(request)
  await createAnnotation(request, document.document_id, {
    page_number: 1,
    annotation_type: 'text_highlight',
    selected_text: 'Sangam Technical Architecture',
    note: 'Reader evidence',
    geometry: [{ x: 0.12, y: 0.12, width: 0.35, height: 0.025 }],
    tags: [],
    color: '#f0c75e',
  })
  await page.goto(`/documents/${document.document_id}`)
  const highlight = page.locator('.pdf-annotation-mark.text_highlight')
  await expect(highlight).toBeVisible()
  await expect(highlight).toHaveCSS('border-top-width', '0px')
  await expect(highlight).toHaveCSS('mix-blend-mode', 'screen')

  await page.getByRole('tab', { name: 'research' }).click()
  await page.getByRole('button', { name: 'Open text highlight annotation' }).click()
  const quote = page.locator('.annotation-quote blockquote')
  await expect(quote).toHaveCSS('-webkit-line-clamp', '3')
  await page.getByRole('button', { name: 'Show more' }).click()
  await expect(page.getByRole('button', { name: 'Show less' })).toBeVisible()
})

test('PDF selection toolbar creates highlights and annotation pins expose actions', async ({
  page,
  request,
}) => {
  test.skip(page.viewportSize()?.width !== 1440, 'desktop project only')
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (value: string) => {
          ;(window as typeof window & { __copiedText?: string }).__copiedText = value
          return Promise.resolve()
        },
      },
    })
  })
  const document = await importSamplePdf(request)
  await createAnnotation(request, document.document_id, {
    page_number: 1,
    annotation_type: 'page_note',
    note: 'Check this premise',
    geometry: [],
    tags: ['review'],
    color: '#78c6a3',
  })
  await page.goto(`/documents/${document.document_id}`)
  await expect(page.locator('.textLayer').first()).toContainText('Sangam Technical Architecture')

  const text = page.locator('.textLayer span').filter({ hasText: 'Sangam Technical Architecture' }).first()
  await text.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    element.closest('.pdf-page')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  const toolbar = page.getByRole('toolbar', { name: 'Selected PDF text actions' })
  await expect(toolbar).toBeVisible()
  await expect(page.getByRole('button', { name: /^Highlight color/ })).toHaveCount(5)
  await page.getByRole('button', { name: 'Copy Markdown citation' }).click()
  await expect
    .poll(() => page.evaluate(() => (window as typeof window & { __copiedText?: string }).__copiedText))
    .toContain('[PDF reader evidence, p. 1]')
  await page.getByRole('button', { name: 'Highlight color 2' }).click()
  await expect(page.locator('.pdf-annotation-mark.text_highlight')).toBeVisible()

  await text.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    element.closest('.pdf-page')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.getByRole('button', { name: 'Add note' }).click()
  await expect(page.getByRole('tab', { name: 'research' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('New annotation')).toBeVisible()
  await page.getByRole('button', { name: 'Close annotation form' }).click()

  const pin = page.getByRole('button', { name: 'Open page note annotation' })
  await pin.hover()
  const preview = page.getByLabel('page note annotation preview')
  await expect(preview).toContainText('Check this premise')
  await expect(preview).toContainText('review')
  await preview.getByRole('button', { name: 'Copy annotation link' }).click()
  await expect
    .poll(() => page.evaluate(() => (window as typeof window & { __copiedText?: string }).__copiedText))
    .toContain(`annotation=${await pin.getAttribute('data-annotation-id')}`)
  await expect(preview.getByRole('button', { name: 'Edit annotation' })).toBeVisible()

  const evidenceDir = process.env.SANGAM_EVIDENCE_DIR
  if (evidenceDir) {
    await page.screenshot({ path: path.join(evidenceDir, 'pdf-in-page-annotations.png') })
  }

  await preview.getByRole('button', { name: 'Edit annotation' }).click()
  await expect(page.getByRole('tab', { name: 'research' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: 'Close annotation detail' })).toBeVisible()

  await page.getByRole('button', { name: 'Close annotation detail' }).click()
  await pin.hover()
  await page.getByLabel('page note annotation preview').getByRole('button', { name: 'Delete' }).click()
  await expect(pin).toHaveCount(0)
})

test('PDF selection actions stay inside the narrow viewport', async ({ page, request }) => {
  test.skip(page.viewportSize()?.width !== 390, 'narrow project only')
  const document = await importSamplePdf(request)
  await page.goto(`/documents/${document.document_id}`)
  const text = page.locator('.textLayer span').filter({ hasText: 'Sangam Technical Architecture' }).first()
  await expect(text).toBeVisible()
  await text.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    element.closest('.pdf-page')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })

  const toolbar = page.getByRole('toolbar', { name: 'Selected PDF text actions' })
  await expect(toolbar).toBeVisible()
  const bounds = await toolbar.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  await expect(page.getByRole('button', { name: 'Add note' })).toBeVisible()
})

test('narrow PDF reader fits the viewport and opens research in the inspector sheet', async ({
  page,
  request,
}) => {
  test.skip(page.viewportSize()?.width !== 390, 'narrow project only')
  const document = await importSamplePdf(request)
  await page.goto(`/documents/${document.document_id}`)
  await expect(page.locator('.pdf-page').first()).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)

  await page.getByRole('button', { name: 'Open document inspector' }).click()
  await page.getByRole('tab', { name: 'research' }).click()
  await expect(page.getByRole('region', { name: 'PDF research' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close document inspector' })).toBeVisible()
})

test('PDF page and zoom survive workbench tab switches', async ({ page, request }) => {
  test.skip(page.viewportSize()?.width !== 1440, 'desktop project only')
  await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      title: 'Tab Switch Target',
      content: '# Target\n\nTarget content for tab switch test.',
      path: 'tab-switch-target.md',
    },
  })
  const document = await importSamplePdf(request, path.join(import.meta.dirname, 'assets/multipage.pdf'))
  await page.goto(`/documents/${document.document_id}`)
  await expect(page.locator('[data-pdf-page="2"]')).toBeVisible()

  const control = page.getByRole('textbox', { name: 'PDF page number' })
  await expect(page.getByLabel('PDF zoom')).toContainText('%')
  await page.locator('[data-pdf-page="2"]').scrollIntoViewIfNeeded()
  await expect
    .poll(() => page.locator('.pdf-page-scroll').evaluate((host) => host.scrollTop))
    .toBeGreaterThan(100)
  await expect(control).toHaveValue('2')
  const savedScrollTop = await page.locator('.pdf-page-scroll').evaluate((host) => host.scrollTop)
  await page.getByRole('button', { name: 'Zoom in' }).click()
  const zoom = await page.getByLabel('PDF zoom').textContent()

  const targetItem = page.getByRole('treeitem', { name: 'tab-switch-target.md' })
  await targetItem.scrollIntoViewIfNeeded()
  await targetItem.click()
  await expect(page.getByRole('tab', { name: 'Tab Switch Target' })).toBeVisible()
  await page.getByRole('tab', { name: 'PDF reader evidence' }).click()
  await expect(page.getByRole('textbox', { name: 'PDF page number' })).toHaveValue('2')
  await expect(page.getByLabel('PDF zoom')).toHaveText(zoom ?? '')
  await expect
    .poll(() => page.locator('.pdf-page-scroll').evaluate((host) => host.scrollTop))
    .toBeGreaterThanOrEqual(savedScrollTop - 2)
})
