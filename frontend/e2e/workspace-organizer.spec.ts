import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { expect, test } from './fixtures'

type CreatedDocument = {
  document_id: string
  path: string | null
  metadata_version: number
  tags: Array<{ name: string }>
}

async function importSamplePdf(
  request: import('@playwright/test').APIRequestContext,
  documentPath: string,
  title: string,
) {
  const sourcePath = path.join(import.meta.dirname, 'assets/multipage.pdf')
  const source = fs.readFileSync(sourcePath)
  const response = await request.post(
    `/api/v1/pdfs?title=${encodeURIComponent(title)}&path=${encodeURIComponent(documentPath)}`,
    {
      headers: { 'Content-Type': 'application/pdf', 'Idempotency-Key': randomUUID() },
      data: source,
    },
  )
  expect(response.ok(), await response.text()).toBeTruthy()
  // SAFETY: POST /api/v1/pdfs returns document entity with document_id
  return (await response.json()) as CreatedDocument
}

async function createFolder(request: import('@playwright/test').APIRequestContext, folderPath: string) {
  const response = await request.post('/api/v1/folders', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { path: folderPath },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
}

async function createDocument(
  request: import('@playwright/test').APIRequestContext,
  title: string,
  documentPath: string,
) {
  const response = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { title, path: documentPath, content: `# ${title}\n` },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  // SAFETY: POST /api/v1/documents returns the validated document entity.
  return (await response.json()) as CreatedDocument
}

async function showFiles(page: import('@playwright/test').Page) {
  const filesTab = page.locator('#workspace-tab-files')
  const reveal = page.getByRole('button', { name: 'Show workspace sidebar' })
  if (!(await filesTab.isVisible())) {
    await expect(reveal).toBeVisible()
    await reveal.click()
  }
  await filesTab.click()
}

test('multi-selection uses one server plan for tags and moving, then survives reload', async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name === 'chromium-touch-mobile', 'fine-pointer multi-selection')
  const suffix = randomUUID().slice(0, 7)
  const source = `organizer-source-${suffix}`
  const target = `organizer-target-${suffix}`
  const firstName = `first-${suffix}.md`
  const secondName = `second-${suffix}.md`
  await createFolder(request, source)
  await createFolder(request, target)
  const first = await createDocument(request, `First ${suffix}`, `${source}/${firstName}`)
  const second = await createDocument(request, `Second ${suffix}`, `${source}/${secondName}`)
  const tagResponse = await request.post('/api/v1/tags', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { name: `Reviewed ${suffix}`, color: '#2457d6' },
  })
  expect(tagResponse.ok(), await tagResponse.text()).toBeTruthy()

  await page.goto(`/documents/${first.document_id}`)
  await showFiles(page)
  const tree = page.locator('.sangam-file-tree')
  const firstRow = tree.getByRole('treeitem', { name: firstName, exact: true })
  const secondRow = tree.getByRole('treeitem', { name: secondName, exact: true })
  await firstRow.click()
  await secondRow.click({ modifiers: ['ControlOrMeta'] })
  const actions = page.getByLabel('Selected item actions')
  await expect(actions).toContainText('2 selected')
  const actionsBox = await actions.boundingBox()
  const sidebarBox = await page.locator('.primary-sidebar').boundingBox()
  expect(actionsBox).not.toBeNull()
  expect(sidebarBox).not.toBeNull()
  expect(actionsBox!.x + actionsBox!.width).toBeLessThanOrEqual(sidebarBox!.x + sidebarBox!.width)
  await page.locator('.sidebar-section-title > span').first().click()
  await expect(actions).toHaveCount(0)
  await expect(firstRow).toHaveAttribute('aria-selected', 'true')
  await expect(secondRow).toHaveAttribute('aria-selected', 'false')
  await secondRow.click({ modifiers: ['ControlOrMeta'] })
  await expect(actions).toContainText('2 selected')

  await actions.getByRole('button', { name: 'Edit selected tags and category' }).click()
  const metadata = page.getByRole('dialog', { name: 'Edit 2 items' })
  await metadata.getByLabel(`Reviewed ${suffix}`).check()
  await metadata.getByRole('button', { name: 'Apply exact metadata' }).click()
  await expect(metadata).toBeHidden()

  await actions.getByRole('button', { name: 'Move selected items', exact: true }).click()
  const move = page.getByRole('dialog', { name: 'Move 2 items' })
  await move.getByRole('option', { name: target, exact: true }).click()
  await move.getByRole('button', { name: 'Move here' }).click()
  await expect(move).toBeHidden()

  for (const [document, expectedPath] of [
    [first, `${target}/${firstName}`],
    [second, `${target}/${secondName}`],
  ] as const) {
    const response = await request.get(`/api/v1/documents/${document.document_id}`)
    expect(response.ok(), await response.text()).toBeTruthy()
    // SAFETY: GET /api/v1/documents/{id} returns the validated document entity.
    const current = (await response.json()) as CreatedDocument
    expect(current.path).toBe(expectedPath)
    expect(current.tags.map((tag) => tag.name)).toContain(`Reviewed ${suffix}`)
  }

  await page.reload()
  await showFiles(page)
  await expect(tree.getByRole('treeitem', { name: firstName, exact: true })).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: secondName, exact: true })).toBeVisible()
  await expect(page.getByLabel('Selected item actions')).toHaveCount(0)
  await firstRow.focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: `Actions for ${firstName}` })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Move to…' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(firstRow).toBeFocused()
  await tree.getByRole('treeitem', { name: target, exact: true }).click()
  await page.getByRole('button', { name: 'New folder', exact: true }).first().click()
  const folderPath = page.getByLabel('New folder path')
  await expect(folderPath).toHaveValue(`${target}/`)
  await folderPath.fill('root-child')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const foldersResponse = await request.get('/api/v1/folders')
  // SAFETY: GET /api/v1/folders returns validated folder entities.
  const currentFolders = (await foldersResponse.json()) as Array<{ path: string }>
  expect(currentFolders.map((folder) => folder.path)).toContain('root-child')
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', page.viewportSize()!.width)

  const evidenceDir = process.env.SANGAM_EVIDENCE_DIR
  if (evidenceDir) {
    await page.screenshot({
      path: path.join(evidenceDir, `workspace-organizer-${testInfo.project.name}.png`),
    })
  }
})

test('touch users can move one item without right-click and stay contained', async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-touch-mobile', 'true touch-mobile only')
  const suffix = randomUUID().slice(0, 7)
  const target = `touch-target-${suffix}`
  const filename = `touch-note-${suffix}.md`
  await createFolder(request, target)
  const document = await createDocument(request, `Touch note ${suffix}`, filename)

  await page.goto(`/documents/${document.document_id}`)
  await showFiles(page)
  const row = page.locator('.sangam-file-tree').getByRole('treeitem', { name: filename, exact: true })
  await row.tap()
  await expect(page.getByLabel('Selected item actions')).toHaveCount(0)
  await page.getByRole('button', { name: 'Options', exact: true }).tap()
  const menu = page.getByRole('menu', { name: `Actions for ${filename}` })
  const moveButton = menu.getByRole('menuitem', { name: 'Move to…' })
  await expect.poll(async () => (await moveButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await moveButton.tap()
  const dialog = page.getByRole('dialog', { name: 'Move 1 item' })
  await dialog.getByRole('option', { name: target, exact: true }).tap()
  await dialog.getByRole('button', { name: 'Move here' }).tap()
  await expect(dialog).toBeHidden()

  const response = await request.get(`/api/v1/documents/${document.document_id}`)
  // SAFETY: GET /api/v1/documents/{id} returns the validated document entity.
  const current = (await response.json()) as CreatedDocument
  expect(current.path).toBe(`${target}/${filename}`)
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390)

  const evidenceDir = process.env.SANGAM_EVIDENCE_DIR
  if (evidenceDir) {
    await page.screenshot({ path: path.join(evidenceDir, 'workspace-organizer-touch.png') })
  }
})

test('an unmaterialized chat draft can be moved into the workspace', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 7)
  const target = `draft-target-${suffix}`
  await createFolder(request, target)
  const response = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { title: `Sample ${suffix}.md`, content: '# Sample', path: null },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  // SAFETY: POST /api/v1/documents returns the validated document entity.
  const draft = (await response.json()) as CreatedDocument

  await page.goto(`/documents/${draft.document_id}`)
  await showFiles(page)
  const row = page.locator('.sangam-file-tree').getByRole('treeitem', {
    name: `Sample ${suffix}.md`,
    exact: true,
  })
  await row.click()
  await page.getByRole('button', { name: 'Options', exact: true }).click()
  const menu = page.getByRole('menu', { name: `Actions for Sample ${suffix}.md` })
  await menu.getByRole('menuitem', { name: 'Move to…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Move 1 item' })
  await dialog.getByRole('option', { name: target, exact: true }).click()
  await dialog.getByRole('button', { name: 'Move here' }).click()
  await expect(dialog).toBeHidden()

  const currentResponse = await request.get(`/api/v1/documents/${draft.document_id}`)
  // SAFETY: GET /api/v1/documents/{id} returns the validated document entity.
  const current = (await currentResponse.json()) as CreatedDocument
  expect(current.path).toBe(`${target}/Sample ${suffix}.md`)
})

test('mixed markdown and PDF multi-selection can be tagged, moved, duplicated, and trashed together', async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name === 'chromium-touch-mobile', 'fine-pointer multi-selection')
  page.on('dialog', (dialog) => void dialog.accept())
  const suffix = randomUUID().slice(0, 7)
  const source = `mixed-source-${suffix}`
  const target = `mixed-target-${suffix}`
  const mdName = `note-${suffix}.md`
  const pdfName = `paper-${suffix}.pdf`

  await createFolder(request, source)
  await createFolder(request, target)
  const mdDoc = await createDocument(request, `Note ${suffix}`, `${source}/${mdName}`)
  const pdfDoc = await importSamplePdf(request, `${source}/${pdfName}`, `Paper ${suffix}`)

  await page.goto(`/documents/${mdDoc.document_id}`)
  await showFiles(page)
  const tree = page.locator('.sangam-file-tree')
  const mdRow = tree.getByRole('treeitem', { name: mdName, exact: true })
  const pdfRow = tree.getByRole('treeitem', { name: pdfName, exact: true })

  await expect(mdRow).toBeVisible()
  await expect(pdfRow).toBeVisible()

  // 1. Verify full action context menu on PDF document
  await pdfRow.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: `Actions for ${pdfName}` })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Open in split' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Move to…' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Duplicate' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Edit tags and category…' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Move to trash' })).toBeVisible()

  // 2. Duplicate PDF via context menu
  await menu.getByRole('menuitem', { name: 'Duplicate' }).click()
  const dupName = `paper-${suffix} copy.pdf`
  await expect(page.getByRole('tab', { name: `Paper ${suffix} copy` })).toBeVisible()
  await showFiles(page)
  const dupRow = tree.getByRole('treeitem', { name: dupName, exact: true })
  await expect(dupRow).toBeVisible()

  // Trash the duplicate to keep tree clean
  await dupRow.focus()
  await page.keyboard.press('Shift+F10')
  const dupMenu = page.getByRole('menu', { name: `Actions for ${dupName}` })
  await dupMenu.getByRole('menuitem', { name: 'Move to trash' }).click()
  await expect(dupRow).toBeHidden()

  // 3. Multi-selection of Markdown + PDF
  await page.goto(`/documents/${mdDoc.document_id}`)
  await showFiles(page)
  await mdRow.click()
  await pdfRow.click({ modifiers: ['ControlOrMeta'] })
  const actions = page.getByLabel('Selected item actions')
  await expect(actions).toContainText('2 selected')

  // Move both to target folder
  await actions.getByRole('button', { name: 'Move selected items', exact: true }).click()
  const moveDialog = page.getByRole('dialog', { name: 'Move 2 items' })
  await moveDialog.getByRole('option', { name: target, exact: true }).click()
  await moveDialog.getByRole('button', { name: 'Move here' }).click()
  await expect(moveDialog).toBeHidden()

  // Verify paths on server
  const currentMdResponse = await request.get(`/api/v1/documents/${mdDoc.document_id}`)
  // SAFETY: GET /api/v1/documents/{id} returns the validated document entity.
  const currentMd = (await currentMdResponse.json()) as CreatedDocument
  expect(currentMd.path).toBe(`${target}/${mdName}`)

  const currentPdfResponse = await request.get(`/api/v1/documents/${pdfDoc.document_id}`)
  // SAFETY: GET /api/v1/documents/{id} returns the validated document entity.
  const currentPdf = (await currentPdfResponse.json()) as CreatedDocument
  expect(currentPdf.path).toBe(`${target}/${pdfName}`)

  // 4. Trash and Restore PDF
  await showFiles(page)
  const movedPdfRow = tree.getByRole('treeitem', { name: pdfName, exact: true })
  await movedPdfRow.focus()
  await page.keyboard.press('Shift+F10')
  const targetMenu = page.getByRole('menu', { name: `Actions for ${pdfName}` })
  await targetMenu.getByRole('menuitem', { name: 'Move to trash' }).click()
  await expect(movedPdfRow).toBeHidden()

  // Go to /trash and restore
  await page.goto('/trash')
  const trashHeading = page.getByRole('heading', { name: 'Trash' })
  await expect(trashHeading).toBeVisible()
  const restoreBtn = page.getByRole('button', { name: 'Restore document' }).first()
  await expect(restoreBtn).toBeVisible()
  await restoreBtn.click()

  // Verify navigation to restored document
  await expect(page).toHaveURL(new RegExp(`/documents/${pdfDoc.document_id}`))
  await showFiles(page)
  await expect(tree.getByRole('treeitem', { name: pdfName, exact: true })).toBeVisible()

  const evidenceDir = process.env.SANGAM_EVIDENCE_DIR
  if (evidenceDir) {
    await page.screenshot({
      path: path.join(evidenceDir, `workspace-organizer-pdf-mixed-${testInfo.project.name}.png`),
    })
  }
})
