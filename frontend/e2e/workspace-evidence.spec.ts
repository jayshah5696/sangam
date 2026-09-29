import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Page, APIRequestContext, TestInfo } from '@playwright/test'
import { annotationSchema, documentSchema } from '../src/api'
import { expect, test } from './fixtures'

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const directory = process.env.SANGAM_EVIDENCE_DIR
  if (!directory) return
  fs.mkdirSync(directory, { recursive: true })
  await page.screenshot({ path: path.join(directory, `${name}-${testInfo.project.name}.png`) })
}

async function create(
  request: APIRequestContext,
  content: string,
  contentType = 'text/markdown',
  title = `Evidence ${randomUUID()}`,
) {
  const response = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { title, content, content_type: contentType },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  return documentSchema.parse(await response.json())
}
async function research(page: Page) {
  await expect(page.getByRole('textbox', { name: 'Document title', exact: true })).toBeVisible()
  const open = page.getByRole('button', { name: 'Open document inspector', exact: true })
  if (!(await page.getByRole('tab', { name: 'research', exact: true }).isVisible())) await open.click()
  await page.getByRole('tab', { name: 'research', exact: true }).click()
}
async function openDraft(page: Page, title: string) {
  const sheet = page.getByRole('dialog', { name: 'Document inspector', exact: true })
  if (await sheet.isVisible())
    await sheet.getByRole('button', { name: 'Collapse document inspector' }).click()
  const reveal = page.getByRole('button', { name: 'Show workspace sidebar', exact: true })
  if (await reveal.isVisible()) await reveal.click()
  await page.getByRole('treeitem', { name: title, exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Document title', exact: true })).toHaveValue(title)
}
async function selectPassage(page: Page, selector = '.editing-surface .markdown-preview p') {
  const passage = page.locator(selector).first()
  await expect(passage).toBeVisible()
  await passage.selectText()
  await passage.dispatchEvent('pointerup')
  await page.getByRole('button', { name: 'Keep as evidence', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Keep as evidence', exact: true })).toContainText('Kept')
  await page.keyboard.press('Escape')
}

test('capture, switch drafts, preview insertion and unopened destination preserve persisted content', async ({
  page,
  request,
}, testInfo) => {
  const source = await create(request, '# Source\n\nThe exact passage supports this conclusion.')
  const a = await create(request, '# A\n\nKeep A intact.')
  const b = await create(request, '# B\n\nKeep B intact.')
  await page.goto(`/documents/${source.document_id}`)
  await page.getByRole('radio', { name: 'preview' }).click()
  await selectPassage(page)
  await openDraft(page, a.title)
  await research(page)
  await expect(page.getByRole('article', { name: `Evidence from ${source.title}` })).toBeVisible()
  await openDraft(page, b.title)
  await research(page)
  await page.getByRole('button', { name: 'Insert at cursor', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'edit' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('.cm-content')).toBeFocused()
  await expect
    .poll(
      async () =>
        documentSchema.parse(await (await request.get(`/api/v1/documents/${b.document_id}`)).json()).content,
    )
    .toContain('The exact passage')
  const savedB = documentSchema.parse(await (await request.get(`/api/v1/documents/${b.document_id}`)).json())
  expect(savedB.content).toContain('Keep B intact.')
  const cardB = page.getByRole('article', { name: `Evidence from ${source.title}` })
  if (!(await cardB.isVisible())) await research(page)
  await cardB.getByRole('button', { name: '+ Attach to a claim', exact: true }).click()
  await cardB.getByLabel('Claim statement').fill('This conclusion is supported by the source.')
  await cardB.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(cardB).toContainText('This conclusion is supported by the source.')
  await capture(page, testInfo, 'evidence-claim')
  const claimTarget = await page.evaluate(
    () => JSON.parse(localStorage.getItem('sangam-workspace-evidence') ?? 'null')[0].claimTarget,
  )
  expect(claimTarget.documentId).toBe(b.document_id)
  expect(claimTarget.anchor).toBeGreaterThan(0)
  expect(
    documentSchema.parse(await (await request.get(`/api/v1/documents/${a.document_id}`)).json()).content,
  ).toBe(a.content)
  await page.reload()
  await research(page)
  await page.getByRole('button', { name: 'Collapse document inspector', exact: true }).click()
  await page.getByRole('radio', { name: 'edit' }).click()
  await expect(page.locator('.cm-content')).toContainText('Keep B intact.')
  await page.getByRole('radio', { name: 'preview' }).click()
  await page.getByRole('link', { name: `Source: ${source.title}`, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`revision=${source.current_revision_id}&text=`))
  await expect(page.locator('.citation-evidence mark')).toHaveText(
    'The exact passage supports this conclusion.',
  )
  await expect
    .poll(() =>
      page.locator('.citation-evidence mark').evaluate((element) => {
        const passage = element.getBoundingClientRect()
        const panel = element.closest('.citation-evidence')?.getBoundingClientRect()
        return Boolean(panel && passage.top >= panel.top && passage.bottom <= panel.bottom)
      }),
    )
    .toBe(true)
  await capture(page, testInfo, 'evidence-pinned-passage')
})

test('replacement remaps an existing passage to the actual new revision', async ({ page, request }) => {
  const source = await create(request, '# Source\n\nA passage that remains.')
  await page.goto(`/documents/${source.document_id}`)
  await page.getByRole('radio', { name: 'preview' }).click()
  await selectPassage(page)
  const replacement = await request.patch(`/api/v1/documents/${source.document_id}`, {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      expected_revision_id: source.current_revision_id,
      content: '# Revised\n\nA new introductory paragraph.\n\nA passage that remains.',
    },
  })
  expect(replacement.ok(), await replacement.text()).toBeTruthy()
  const head = documentSchema.parse(await replacement.json())
  await page.reload()
  await research(page)
  await page.getByRole('button', { name: 'Compare source versions' }).click()
  const modal = page.getByRole('dialog', { name: 'Compare source versions', exact: true })
  await expect(modal.getByRole('button', { name: 'Update to current head revision' })).toBeEnabled()
  await modal.getByRole('button', { name: 'Update to current head revision' }).click()
  await expect(modal).not.toBeVisible()
  const stored = await page.evaluate(
    () => JSON.parse(localStorage.getItem('sangam-workspace-evidence') ?? 'null')[0],
  )
  expect(stored.pinnedRevisionId).toBe(head.current_revision_id)
  expect(head.content.slice(stored.textLocator.start, stored.textLocator.end)).toBe(stored.selectedText)
})

test('Markdown source titles cannot change the citation destination', async ({ page, request }) => {
  const source = await create(
    request,
    '# Source\n\nA passage with a literal source title.',
    'text/markdown',
    'Research ](https://example.com) [notes \\ <https://example.com> **draft** `literal`',
  )
  const draft = await create(request, '# Draft\n\nOriginal draft content.')
  await page.goto(`/documents/${source.document_id}`)
  await page.getByRole('radio', { name: 'preview' }).click()
  await selectPassage(page)
  await openDraft(page, draft.title)
  await research(page)
  await page.getByRole('button', { name: 'Insert at cursor', exact: true }).click()
  await expect
    .poll(
      async () =>
        documentSchema.parse(await (await request.get(`/api/v1/documents/${draft.document_id}`)).json())
          .content,
    )
    .toContain(source.current_revision_id)
  const sheet = page.getByRole('dialog', { name: 'Document inspector', exact: true })
  if (await sheet.isVisible())
    await sheet.getByRole('button', { name: 'Collapse document inspector' }).click()
  await page.getByRole('radio', { name: 'preview' }).click()
  const link = page.getByRole('link', { name: `Source: ${source.title}`, exact: true })
  await expect(link).toHaveAttribute(
    'href',
    new RegExp(`/documents/${source.document_id}\\?revision=${source.current_revision_id}`),
  )
  await link.click()
  await expect(page.locator('.citation-evidence mark')).toHaveText('A passage with a literal source title.')
})

test('rendered formatting and repeated passages keep the selected occurrence', async ({ page, request }) => {
  const source = await create(
    request,
    '# Source\n\nAn **important** conclusion.\n\nAn **important** conclusion.',
  )
  await page.goto(`/documents/${source.document_id}`)
  await page.getByRole('radio', { name: 'preview' }).click()
  await selectPassage(page, '.editing-surface .markdown-preview p:nth-of-type(2)')
  await research(page)
  await page.getByRole('button', { name: 'Source', exact: true }).click()
  const mark = page.locator('.citation-evidence mark')
  await expect(mark).toHaveText('An important conclusion.')
  const before = await mark.evaluate((element) => element.previousSibling?.textContent ?? '')
  expect(before).toContain('An important conclusion.')
})

test('historical capture and absent replacement quote preserve the original pin and Ask context', async ({
  page,
  request,
}) => {
  const source = await create(request, '# Original\n\nAn immutable original passage.')
  const updated = await request.patch(`/api/v1/documents/${source.document_id}`, {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      content: '# Changed\n\nEntirely different wording.',
      expected_revision_id: source.current_revision_id,
    },
  })
  expect(updated.ok(), await updated.text()).toBeTruthy()
  await page.goto(`/documents/${source.document_id}?revision=${source.current_revision_id}`)
  await selectPassage(page, '.citation-evidence .markdown-preview p')
  await research(page)
  const card = page.getByRole('article', { name: `Evidence from ${source.title}` })
  await expect(card).toContainText(source.current_revision_id.slice(0, 8))
  await card.getByRole('button', { name: 'Compare source versions' }).click()
  const modal = page.getByRole('dialog', { name: 'Compare source versions', exact: true })
  await expect(modal.getByRole('button', { name: 'Update to current head revision' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(modal).not.toBeVisible()
  await expect(card.getByRole('button', { name: 'Compare source versions' })).toBeFocused()
  await card.getByRole('button', { name: 'Ask', exact: true }).click()
  await expect(page).toHaveURL(/\/chat/)
  await expect(page.getByText('The document changed before chat opened')).not.toBeVisible()
  await page.getByText('Using selection: 30 chars').click()
  await expect(page.getByText('An immutable original passage.', { exact: false }).first()).toBeVisible()
  expect(new URL(page.url()).searchParams.get('revision')).toBe(source.current_revision_id)
  expect(await page.evaluate(() => history.state.sangamChatContext.selectedText)).toBe(
    'An immutable original passage.',
  )
})

test('history inspector selection captures the displayed historical revision', async ({ page, request }) => {
  const source = await create(request, '# Original\n\nA passage from the history inspector.')
  const updated = await request.patch(`/api/v1/documents/${source.document_id}`, {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { expected_revision_id: source.current_revision_id, content: '# Current\n\nA different head.' },
  })
  expect(updated.ok(), await updated.text()).toBeTruthy()
  await page.goto(`/documents/${source.document_id}`)
  await research(page)
  await page.getByRole('tab', { name: 'history', exact: true }).click()
  await page
    .locator('.revision')
    .filter({ hasText: 'created this document' })
    .getByRole('button', { name: 'Preview', exact: true })
    .click()
  await selectPassage(page, '.revision-render-preview .markdown-preview p')
  await page.getByRole('tab', { name: 'research', exact: true }).click()
  const card = page.getByRole('article', { name: `Evidence from ${source.title}` })
  await expect(card).toContainText('A passage from the history inspector.')
  await expect(card).toContainText(source.current_revision_id.slice(0, 8))
})

test('unsaved editor selection is committed before capture and source opens the structured passage', async ({
  page,
  request,
}) => {
  const source = await create(request, '# Source\n\nOriginal text.')
  await page.goto(`/documents/${source.document_id}`)
  await page.getByRole('radio', { name: 'edit' }).click()
  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\n\nUnsaved precise passage.')
  await page.keyboard.press('ControlOrMeta+Shift+ArrowUp')
  await page.getByRole('button', { name: 'Keep evidence', exact: true }).click()
  await research(page)
  const card = page.getByRole('article', { name: `Evidence from ${source.title}` })
  await expect(card).toContainText('Unsaved precise passage.')
  const head = documentSchema.parse(
    await (await request.get(`/api/v1/documents/${source.document_id}`)).json(),
  )
  expect(head.content).toContain('Unsaved precise passage.')
  expect(head.current_revision_id).not.toBe(source.current_revision_id)
  await card.getByRole('button', { name: 'Source', exact: true }).click()
  await expect(page).toHaveURL(/revision=.*&text=/)
  await expect(page.locator('.citation-evidence mark')).toContainText('Unsaved precise passage.')
})

test('storage quota failure never announces Keep success', async ({ page, request }) => {
  const source = await create(request, '# Source\n\nA durable passage.')
  await page.goto(`/documents/${source.document_id}`)
  await page.getByRole('radio', { name: 'preview' }).click()
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    }
  })
  const p = page.locator('.editing-surface .markdown-preview p').first()
  await p.selectText()
  await p.dispatchEvent('pointerup')
  await page.getByRole('button', { name: 'Keep as evidence', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Evidence storage' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Keep as evidence', exact: true })).not.toContainText('Kept')
  expect(await page.evaluate(() => localStorage.getItem('sangam-workspace-evidence'))).toBeNull()
})

test('HTML has faithful selectable accessible source text', async ({ page, request }) => {
  const source = await create(
    request,
    '<!doctype html><html><body><h1>Article</h1><p>HTML passage with <strong>meaningful emphasis</strong> and a conclusion.</p></body></html>',
    'text/html',
  )
  await page.goto(`/documents/${source.document_id}`)
  await page.getByRole('radio', { name: 'preview' }).click()
  await page.getByText('Selectable article text', { exact: true }).click()
  await selectPassage(page, '.html-source-text p:nth-child(2)')
  await research(page)
  await expect(page.getByRole('article', { name: `Evidence from ${source.title}` })).toContainText(
    'HTML passage with meaningful emphasis and a conclusion.',
  )
  const updated = await request.patch(`/api/v1/documents/${source.document_id}`, {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      expected_revision_id: source.current_revision_id,
      content: '<h1>Updated article</h1><p>HTML passage with meaningful emphasis and a conclusion.</p>',
    },
  })
  expect(updated.ok(), await updated.text()).toBeTruthy()
  await page.reload()
  await research(page)
  const compare = page.getByRole('button', { name: 'Compare source versions', exact: true })
  await compare.click()
  const dialog = page.getByRole('dialog', { name: 'Compare source versions', exact: true })
  await expect(dialog.getByRole('button', { name: 'Update to current head revision' })).toBeEnabled()
  await expect(dialog.locator('iframe')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Close comparison', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(compare).toBeFocused()
})

test('HTML destination receives a real quotation and an accessible pinned source link', async ({
  page,
  request,
}) => {
  const source = await create(request, '# Source\n\nA precise <literal> quotation.')
  const draft = await create(
    request,
    '<!doctype html><html><body><h1>Draft</h1><p>Original paragraph.</p></body></html>',
    'text/html',
  )
  await page.goto(`/documents/${source.document_id}`)
  await page.getByRole('radio', { name: 'preview' }).click()
  await selectPassage(page)
  await openDraft(page, draft.title)
  await research(page)
  await page.getByRole('button', { name: 'Insert at cursor', exact: true }).click()
  await expect
    .poll(
      async () =>
        documentSchema.parse(await (await request.get(`/api/v1/documents/${draft.document_id}`)).json())
          .content,
    )
    .toContain('<blockquote>')
  const saved = documentSchema.parse(
    await (await request.get(`/api/v1/documents/${draft.document_id}`)).json(),
  )
  expect(saved.content).toContain('Original paragraph.')
  expect(saved.content).toContain('&lt;literal&gt;')
  const sheet = page.getByRole('dialog', { name: 'Document inspector', exact: true })
  if (await sheet.isVisible())
    await sheet.getByRole('button', { name: 'Collapse document inspector' }).click()
  await page.getByRole('radio', { name: 'preview' }).click()
  await page.getByText('Selectable article text', { exact: true }).click()
  await page.getByRole('link', { name: `Source: ${source.title}`, exact: true }).click()
  await expect(page.locator('.citation-evidence mark')).toHaveText('A precise <literal> quotation.')
})

test('PDF evidence retains geometry and annotation, opens an unopened draft safely, then returns to the requested page', async ({
  page,
  request,
}) => {
  const response = await request.post(`/api/v1/pdfs?title=Evidence%20PDF&path=research/${randomUUID()}.pdf`, {
    headers: { 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/pdf' },
    data: fs.readFileSync(path.join(import.meta.dirname, 'assets/multipage.pdf')),
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  const pdf = documentSchema.parse(await response.json())
  const annotationResponse = await request.post(`/api/v1/pdfs/${pdf.document_id}/annotations`, {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      annotation_type: 'text_highlight',
      page_number: 2,
      selected_text: 'Sangam Technical Architecture',
      geometry: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.05 }],
      note: 'Evidence annotation',
      tags: [],
      color: '#f0c75e',
    },
  })
  expect(annotationResponse.ok(), await annotationResponse.text()).toBeTruthy()
  const annotation = annotationSchema.parse(await annotationResponse.json())
  const draft = await create(request, '# Unopened\n\nKeep the original body.')
  await page.goto(`/documents/${pdf.document_id}`)
  await expect(page.locator('.pdf-page').first()).toBeVisible()
  await page.evaluate(
    async ({ id, revision, content }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const opening = indexedDB.open('sangam-browser-state', 1)
        opening.onupgradeneeded = () => {
          if (!opening.result.objectStoreNames.contains('document-drafts'))
            opening.result.createObjectStore('document-drafts', { keyPath: 'documentId' })
        }
        opening.onsuccess = () => resolve(opening.result)
        opening.onerror = () => reject(opening.error)
      })
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('document-drafts', 'readwrite')
        tx.objectStore('document-drafts').put({
          documentId: id,
          baseRevisionId: revision,
          content: `${content}\n\nRecovered unsaved line.`,
          updatedAt: Date.now(),
        })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      db.close()
    },
    { id: draft.document_id, revision: draft.current_revision_id, content: draft.content },
  )
  await research(page)
  await page.getByRole('button', { name: /text highlight · p\. 2/ }).click()
  await page
    .locator('.research-handoff')
    .getByRole('button', { name: 'Keep as evidence', exact: true })
    .click()
  const card = page.getByRole('article', { name: 'Evidence from Evidence PDF' })
  await expect(card).toContainText('Sangam Technical Architecture')
  const sheet = page.getByRole('dialog', { name: 'Document inspector', exact: true })
  if (await sheet.isVisible())
    await sheet.getByRole('button', { name: 'Collapse document inspector' }).click()
  await page.getByRole('textbox', { name: 'PDF page number' }).fill('1')
  await page.getByRole('textbox', { name: 'PDF page number' }).press('Enter')
  await research(page)
  await card.getByLabel('Destination draft').selectOption(draft.document_id)
  await card.getByRole('button', { name: '+ Attach to a claim', exact: true }).click()
  await card.getByLabel('Claim statement').fill('This PDF passage supports the draft.')
  await card.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(card).toContainText('This PDF passage supports the draft.')
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('sangam-workspace-evidence') ?? 'null')[0].claimTarget?.documentId,
    ),
  ).toBe(draft.document_id)
  await card.getByRole('button', { name: 'Insert at cursor', exact: true }).click()
  await expect(page.locator('.cm-content')).toBeFocused()
  await expect
    .poll(
      async () =>
        documentSchema.parse(await (await request.get(`/api/v1/documents/${draft.document_id}`)).json())
          .content,
    )
    .toContain('Sangam Technical Architecture')
  expect(
    documentSchema.parse(await (await request.get(`/api/v1/documents/${draft.document_id}`)).json()).content,
  ).toContain('Keep the original body.')
  expect(
    documentSchema.parse(await (await request.get(`/api/v1/documents/${draft.document_id}`)).json()).content,
  ).toContain('Recovered unsaved line.')
  await research(page)
  await page
    .getByRole('article', { name: 'Evidence from Evidence PDF' })
    .getByRole('button', { name: 'Source', exact: true })
    .click()
  await expect(page).toHaveURL(new RegExp(`page=2&annotation=${annotation.annotation_id}`))
  await expect(page.getByRole('textbox', { name: 'PDF page number' })).toHaveValue('2')
  await research(page)
  await expect(page.locator('.annotation-quote')).toContainText('Sangam Technical Architecture')
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('sangam-workspace-evidence') ?? 'null'),
  )
  expect(stored[0].geometry).toEqual(annotation.geometry)
  expect(stored[0].annotationId).toBe(annotation.annotation_id)
  expect(stored[0].pinnedRevisionId).toBe(pdf.current_revision_id)
  await card.getByRole('button', { name: 'Ask', exact: true }).click()
  await expect(page).toHaveURL(/\/chat/)
  expect(await page.evaluate(() => history.state.sangamChatContext)).toEqual({
    selectedText: 'Sangam Technical Architecture',
    pdfPageNumber: 2,
    annotationId: annotation.annotation_id,
  })
  expect(new URL(page.url()).searchParams.get('revision')).toBe(pdf.current_revision_id)
})

test('keeping actual PDF text selection preserves the immutable source and geometry', async ({
  page,
  request,
}) => {
  const response = await request.post(
    `/api/v1/pdfs?title=Selectable%20PDF&path=research/${randomUUID()}.pdf`,
    {
      headers: { 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/pdf' },
      data: fs.readFileSync(path.join(import.meta.dirname, 'assets/multipage.pdf')),
    },
  )
  expect(response.ok(), await response.text()).toBeTruthy()
  const pdf = documentSchema.parse(await response.json())
  await page.goto(`/documents/${pdf.document_id}`)
  const passage = page.locator('.textLayer span').filter({ hasText: 'Sangam Technical Architecture' }).first()
  await expect(passage).toBeVisible()
  await passage.selectText()
  await passage.dispatchEvent('mouseup')
  const toolbar = page.getByRole('toolbar', { name: 'Selected PDF text actions' })
  await expect(toolbar).toBeVisible()
  await toolbar.getByRole('button', { name: 'Keep as evidence', exact: true }).click()
  await expect(toolbar.getByRole('button', { name: 'Keep as evidence', exact: true })).toContainText('Kept')
  const secondPassage = page
    .locator('.textLayer span')
    .filter({ hasText: 'A privacy-first document server' })
    .first()
  await expect(secondPassage).toBeVisible()
  await secondPassage.selectText()
  await secondPassage.dispatchEvent('mouseup')
  await expect(toolbar.getByRole('button', { name: 'Keep as evidence', exact: true })).not.toContainText(
    'Kept',
  )
  await page.keyboard.press('Escape')
  await page.reload()
  await research(page)
  await expect(page.getByRole('article', { name: 'Evidence from Selectable PDF' })).toContainText(
    'Sangam Technical Architecture',
  )
  const stored = await page.evaluate(
    () => JSON.parse(localStorage.getItem('sangam-workspace-evidence') ?? 'null')[0],
  )
  expect(stored.geometry.length).toBeGreaterThan(0)
  expect(stored.pageNumber).toBe(1)
  expect(stored.pinnedRevisionId).toBe(pdf.current_revision_id)
})

test('invalid storage is visible and preserved rather than replaced by an empty collection', async ({
  page,
  request,
}) => {
  const draft = await create(request, '# Draft')
  await page.goto('/')
  await page.evaluate(() => localStorage.setItem('sangam-workspace-evidence', '[{"selectedText":42}]'))
  await page.goto(`/documents/${draft.document_id}`)
  await research(page)
  await expect(page.getByRole('alert').filter({ hasText: 'Evidence storage' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('sangam-workspace-evidence'))).toBe(
    '[{"selectedText":42}]',
  )
})

test('concurrent tabs keep both passages durably', async ({ page, context, request }) => {
  const source = await create(request, '# Source\n\nConcurrent passage.')
  const second = await context.newPage()
  for (const tab of [page, second]) {
    await tab.goto(`/documents/${source.document_id}`)
    await tab.getByRole('radio', { name: 'preview' }).click()
    const p = tab.locator('.editing-surface .markdown-preview p').first()
    await p.selectText()
    await p.dispatchEvent('pointerup')
  }
  await Promise.all(
    [page, second].map((tab) => tab.getByRole('button', { name: 'Keep as evidence', exact: true }).click()),
  )
  await page.keyboard.press('Escape')
  await research(page)
  await expect(page.getByRole('article', { name: `Evidence from ${source.title}` })).toHaveCount(2)
  await page.reload()
  await research(page)
  await expect(page.getByRole('article', { name: `Evidence from ${source.title}` })).toHaveCount(2)
  await second.close()
})

test('comparison contains focus, closes with Escape, returns focus and fits minimum/landscape widths', async ({
  page,
  request,
}, testInfo) => {
  const source = await create(request, '# Source\n\nA comparison passage.')
  await page.goto(`/documents/${source.document_id}`)
  await page.getByRole('radio', { name: 'preview' }).click()
  await selectPassage(page)
  await selectPassage(page)
  for (const width of [901, 899, 651, 649, 320, 844]) {
    await page.setViewportSize({ width, height: width === 844 ? 390 : 844 })
    await research(page)
    const buttons = page
      .locator('.workspace-evidence-rail')
      .getByRole('button', { name: 'Compare', exact: true })
    await buttons.first().click()
    await buttons.nth(1).click()
    const modal = page.getByRole('dialog', { name: 'Compare evidence excerpts' })
    await expect(modal).toBeVisible()
    const bounds = await modal.locator('.evidence-modal-content').boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds?.x).toBeGreaterThanOrEqual(0)
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width)
    expect(bounds?.y).toBeGreaterThanOrEqual(0)
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(width === 844 ? 390 : 844)
    if ([901, 320, 844].includes(width)) await capture(page, testInfo, `evidence-comparison-${width}`)
    await expect(modal.getByRole('button', { name: 'Close comparison' })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(modal.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(
      1,
    )
    if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) {
      expect(
        (await modal.getByRole('button', { name: 'Close comparison' }).boundingBox())?.height,
      ).toBeGreaterThanOrEqual(44)
    }
    await page.keyboard.press('Escape')
    await expect(modal).not.toBeVisible()
    await expect(buttons.nth(1)).toBeFocused()
  }
})
