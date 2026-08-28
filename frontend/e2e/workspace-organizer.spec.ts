import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from './fixtures'

async function seedOrganizer(request: APIRequestContext) {
  const suffix = randomUUID().slice(0, 6)
  const inbox = `inbox-${suffix}`
  const archive = `archive-${suffix}`
  for (const folder of [inbox, archive]) {
    const response = await request.post('/api/v1/folders', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: { path: folder },
    })
    expect(response.ok(), await response.text()).toBeTruthy()
  }
  const documents = []
  for (const name of ['launch-plan', 'source-notes']) {
    const response = await request.post('/api/v1/documents', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: {
        title: `${name} ${suffix}`,
        content: `# ${name}\n`,
        path: `${inbox}/${name}-${suffix}.md`,
      },
    })
    expect(response.ok(), await response.text()).toBeTruthy()
    documents.push((await response.json()) as { document_id: string; path: string })
  }
  return { suffix, inbox, archive, documents }
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth)
}

test('multi-selection moves documents through the shared organizer and keeps folder creation scoped', async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop behavior proof')
  const seeded = await seedOrganizer(request)
  await page.goto(`/documents/${seeded.documents[0]!.document_id}`)

  const tree = page.locator('.sangam-file-tree')
  const first = tree.getByRole('treeitem', { name: `launch-plan-${seeded.suffix}.md`, exact: true })
  const second = tree.getByRole('treeitem', { name: `source-notes-${seeded.suffix}.md`, exact: true })
  await expect(first).toBeVisible()
  await expect(second).toBeVisible()
  await first.click()
  await second.click({ modifiers: ['ControlOrMeta'] })
  await expect(first).toHaveAttribute('aria-selected', 'true')
  await expect(second).toHaveAttribute('aria-selected', 'true')

  const bulk = page.getByRole('toolbar', { name: 'Selected document actions' })
  await expect(bulk).toContainText('2 selected')
  await bulk.getByRole('button', { name: 'Move selected documents', exact: true }).click()
  const moveDialog = page.getByRole('dialog', { name: 'Move to…' })
  await expect(moveDialog).toBeVisible()
  await expect(moveDialog).toContainText('2 documents')
  await moveDialog.getByText(seeded.archive, { exact: true }).click()

  const evidenceDir = process.env.SANGAM_EVIDENCE_DIR
  if (evidenceDir) {
    await page.screenshot({
      path: path.join(evidenceDir, 'issue-162-after-desktop-move-plan.png'),
      animations: 'disabled',
      scale: 'css',
    })
  }

  await moveDialog.getByRole('button', { name: 'Move', exact: true }).click()
  await expect(moveDialog).toBeHidden()
  await expect(page.locator('.explorer-notice')).toContainText('2 completed')
  await expect
    .poll(async () => {
      const response = await request.get('/api/v1/documents?limit=200&offset=0')
      const payload = (await response.json()) as Array<{ document_id: string; path: string }>
      return payload
        .filter((document) =>
          seeded.documents.some((seededDocument) => seededDocument.document_id === document.document_id),
        )
        .map((document) => document.path)
        .sort()
    })
    .toEqual([
      `${seeded.archive}/launch-plan-${seeded.suffix}.md`,
      `${seeded.archive}/source-notes-${seeded.suffix}.md`,
    ])

  const archiveRow = tree.getByRole('treeitem', { name: seeded.archive, exact: true })
  await archiveRow.click()
  await page.getByRole('button', { name: 'New folder' }).click()
  const create = page.getByRole('textbox', { name: 'New folder name' })
  await expect(page.locator('.explorer-create')).toContainText(`${seeded.archive} /`)
  await create.fill('reviewed')
  await create.press('Enter')
  await expect
    .poll(async () => {
      const response = await request.get('/api/v1/folders')
      const folders = (await response.json()) as Array<{ path: string }>
      return folders.some((folder) => folder.path === `${seeded.archive}/reviewed`)
    })
    .toBe(true)

  await first.focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: `Actions for launch-plan-${seeded.suffix}.md` })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Move to…' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(first).toBeFocused()
})

test('touch-mobile exposes 44px rows, visible actions, and an in-viewport destination dialog', async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-touch-mobile', 'true touch-mobile proof')
  const seeded = await seedOrganizer(request)
  await page.goto(`/documents/${seeded.documents[0]!.document_id}`)
  await page.getByRole('button', { name: 'Show workspace sidebar' }).tap()

  const tree = page.locator('.sangam-file-tree')
  // Check row height of a visible document row
  const row = tree.getByRole('treeitem', { name: `launch-plan-${seeded.suffix}.md`, exact: true })
  await expect(row).toBeVisible()
  const rowBox = await row.boundingBox()
  expect(rowBox).not.toBeNull()
  expect(rowBox!.height).toBeGreaterThanOrEqual(44)

  // On touch-mobile, use keyboard context menu (Shift+F10) to open the action menu
  // without navigating away (tapping a different row would close the sidebar)
  await row.focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: `Actions for launch-plan-${seeded.suffix}.md` })
  await expect(menu).toBeVisible()
  const menuBox = await menu.boundingBox()
  expect(menuBox).not.toBeNull()
  expect(menuBox!.x).toBeGreaterThanOrEqual(0)
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  for (const item of await menu.getByRole('menuitem').all()) {
    const box = await item.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThanOrEqual(44)
  }

  const evidenceDir = process.env.SANGAM_EVIDENCE_DIR
  if (evidenceDir) {
    await page.screenshot({
      path: path.join(evidenceDir, 'issue-162-after-touch-actions.png'),
      animations: 'disabled',
      scale: 'css',
    })
  }

  await menu.getByRole('menuitem', { name: 'Move to…' }).tap()
  const dialog = page.getByRole('dialog', { name: 'Move to…' })
  await expect(dialog).toBeVisible()
  const dialogBox = await dialog.boundingBox()
  expect(dialogBox).not.toBeNull()
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0)
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  await expectNoHorizontalOverflow(page)
  await dialog.getByRole('button', { name: 'Cancel' }).tap()
  await expect(dialog).toBeHidden()
})
