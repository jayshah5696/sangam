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

test('PDF page and zoom survive workbench tab switches', async ({ page, request, seededWorkspace }) => {
  test.skip(page.viewportSize()?.width !== 1440, 'desktop project only')
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

  await page.getByRole('treeitem', { name: seededWorkspace.documentTitle }).click()
  await expect(page.getByRole('tab', { name: seededWorkspace.documentTitle })).toBeVisible()
  await page.getByRole('tab', { name: 'PDF reader evidence' }).click()
  await expect(page.getByRole('textbox', { name: 'PDF page number' })).toHaveValue('2')
  await expect(page.getByLabel('PDF zoom')).toHaveText(zoom ?? '')
  await expect
    .poll(() => page.locator('.pdf-page-scroll').evaluate((host) => host.scrollTop))
    .toBeGreaterThanOrEqual(savedScrollTop - 2)
})
