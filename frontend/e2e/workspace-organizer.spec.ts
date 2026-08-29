import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { expect, test } from './fixtures'

type CreatedDocument = {
  document_id: string
  path: string | null
  metadata_version: number
  tags: Array<{ name: string }>
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

  await actions.getByRole('button', { name: 'Tags' }).click()
  const metadata = page.getByRole('dialog', { name: 'Edit 2 items' })
  await metadata.getByLabel(`Reviewed ${suffix}`).check()
  await metadata.getByRole('button', { name: 'Apply exact metadata' }).click()
  await expect(metadata).toBeHidden()

  await actions.getByRole('button', { name: 'Move to…' }).click()
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
  await tree.getByRole('treeitem', { name: target, exact: true }).click()
  await page.getByRole('button', { name: 'New folder', exact: true }).first().click()
  await page.getByLabel('New folder name').fill('child')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(tree.getByRole('treeitem', { name: 'child', exact: true })).toBeVisible()
  const foldersResponse = await request.get('/api/v1/folders')
  // SAFETY: GET /api/v1/folders returns validated folder entities.
  const currentFolders = (await foldersResponse.json()) as Array<{ path: string }>
  expect(currentFolders.map((folder) => folder.path)).toContain(`${target}/child`)
  await firstRow.focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: `Actions for ${firstName}` })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Move to…' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(firstRow).toBeFocused()
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
  const moveButton = page.getByLabel('Selected item actions').getByRole('button', {
    name: 'Move to…',
  })
  const targetBox = await moveButton.boundingBox()
  expect(targetBox).not.toBeNull()
  expect(targetBox!.height).toBeGreaterThanOrEqual(44)
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
