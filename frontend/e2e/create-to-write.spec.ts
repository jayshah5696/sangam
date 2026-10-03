import { expect, openIfClosed, test } from './fixtures'
import { documentSchema } from '../src/api'
import type { Page, APIRequestContext } from '@playwright/test'

async function createFromHome(page: Page, format: 'Markdown' | 'HTML' = 'Markdown') {
  await page.getByRole('button', { name: 'New document', exact: true }).click()
  await page.getByRole('menuitem', { name: format, exact: true }).click()
}

test('Home resumes work and exposes one document creation menu', async ({
  page,
  seededWorkspace,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('sangam.home-project', ''))
  await page.goto('/')
  const home = page.locator('.welcome')
  const recent = home.locator('.welcome-recent').first()
  await expect(recent.getByRole('link', { name: seededWorkspace.documentTitle })).toBeVisible()
  await expect(home.getByRole('button', { name: 'Capture', exact: true })).toHaveCount(1)
  const create = home.getByRole('button', { name: 'New document', exact: true })
  await expect(create).toBeVisible()
  await create.click()
  const menu = page.getByRole('menu', { name: 'New document', exact: true })
  await expect(menu.getByRole('menuitem', { name: 'Markdown', exact: true })).toBeFocused()
  await expect(menu.getByRole('menuitem', { name: 'HTML', exact: true })).toBeVisible()
  const bounds = await menu.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  if (testInfo.project.use.hasTouch) {
    await expect.poll(async () => (await create.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await expect
      .poll(
        async () =>
          (await menu.getByRole('menuitem', { name: 'Markdown', exact: true }).boundingBox())!.height,
      )
      .toBeGreaterThanOrEqual(44)
  }
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(create).toBeFocused()
  await recent.getByRole('link', { name: seededWorkspace.documentTitle }).click()
  await expect(page).toHaveURL(new RegExp(`/documents/${seededWorkspace.documentId}$`))
})

test('Home creation stays reachable across compact widths and themes', async ({
  page,
  seededWorkspace,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('sangam.home-project', ''))
  await page.goto('/')
  await expect(page.locator('.welcome-recent').first()).toContainText(seededWorkspace.documentTitle)
  for (const theme of ['parchment', 'cobalt', 'river', 'midnight']) {
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: testInfo.outputPath(`home-${theme}.png`), animations: 'disabled' })
  }
  for (const viewport of [
    { width: 651, height: 800 },
    { width: 649, height: 800 },
    { width: 320, height: 568 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport)
    const create = page.getByRole('button', { name: 'New document', exact: true })
    await expect(create).toBeInViewport()
    await create.click()
    const menu = page.getByRole('menu', { name: 'New document', exact: true })
    await expect(menu).toBeVisible()
    const bounds = await menu.boundingBox()
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(
      1,
    )
    await page.screenshot({
      path: testInfo.outputPath(`home-menu-${viewport.width}.png`),
      animations: 'disabled',
    })
    await page.keyboard.press('Escape')
    await expect(create).toBeFocused()
  }
})

async function proveSaved(page: Page, request: APIRequestContext) {
  const marker = `Persisted ${crypto.randomUUID()}`
  await page.keyboard.type(marker)
  const id = new URL(page.url()).pathname.split('/').at(-1)
  await expect
    .poll(
      async () => documentSchema.parse(await (await request.get(`/api/v1/documents/${id}`)).json()).content,
    )
    .toContain(marker)
  await page.reload()
  await page.getByRole('radio', { name: 'edit' }).click()
  await expect(page.locator('.cm-content')).toContainText(marker)
}

test('creating a Markdown draft opens the editor with the cursor ready', async ({ page, request }) => {
  await page.goto('/')
  await createFromHome(page)

  await expect(page).toHaveURL(/\/documents\/[^/]+/)
  await expect(page.getByRole('radio', { name: 'edit' })).toHaveAttribute('aria-checked', 'true')
  const editor = page.locator('.cm-content')
  await expect(editor).toBeFocused()
  await expect(editor).toContainText('# Untitled document')
  await expect(page.locator('.editor-tools')).toContainText('Ln 3, Col 1')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  await page.keyboard.type('A note')
  await expect(editor.locator('.cm-line')).toHaveText(['# Untitled document', '', 'A note'])
  await expect(page.getByRole('status').filter({ hasText: 'Saved draft' })).toBeVisible()
  const id = new URL(page.url()).pathname.split('/').at(-1)
  await expect
    .poll(
      async () => documentSchema.parse(await (await request.get(`/api/v1/documents/${id}`)).json()).content,
    )
    .toBe('# Untitled document\n\nA note')

  await page.getByRole('radio', { name: 'preview' }).click()
  await page.reload()
  await expect(page.getByRole('radio', { name: 'preview' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('.markdown-preview')).toContainText('A note')
})

test('creating an HTML draft from Home opens it ready to write', async ({ page, request }) => {
  await page.goto('/')
  await createFromHome(page, 'HTML')

  await expect(page.getByRole('radio', { name: 'edit' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('.cm-content')).toBeFocused()
  await expect(page.locator('.cm-content')).toContainText('<!doctype html>')
  await proveSaved(page, request)
})

test('creating a draft from the command palette opens it ready to write', async ({ page, request }) => {
  await page.goto('/')
  await page.locator('body').press('ControlOrMeta+k')
  await page.getByRole('textbox', { name: 'Search workspace and actions' }).fill('New document')
  await page.getByRole('option', { name: /New document/ }).click()

  await expect(page.getByRole('radio', { name: 'edit' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('.cm-content')).toBeFocused()
  await expect(page.getByRole('dialog', { name: 'Document inspector', exact: true })).not.toBeVisible()
  await proveSaved(page, request)
})

test('creating a workspace file opens it ready to write', async ({ page, request }) => {
  await page.goto('/')
  await openIfClosed(
    page.getByRole('button', { name: 'Show workspace sidebar' }),
    page.locator('#workspace-tab-files'),
  )
  await page.locator('#workspace-tab-files').click()
  await page.getByRole('button', { name: 'New file' }).click()
  await page.getByRole('textbox', { name: 'New file path' }).fill(`notes/new-${crypto.randomUUID()}.md`)
  await page.locator('.explorer-create').getByRole('button', { name: 'Create' }).click()

  await expect(page.getByRole('radio', { name: 'edit' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('.cm-content')).toBeFocused()
  await proveSaved(page, request)
})

test('a warm open inspector does not steal new document writing focus', async ({ page, request }) => {
  await page.goto('/')
  await createFromHome(page)
  await expect(page.locator('.cm-content')).toBeFocused()
  await openIfClosed(
    page.getByRole('button', { name: 'Open document inspector', exact: true }),
    page.getByRole('tab', { name: 'properties', exact: true }),
  )
  await page.goto('/')
  await createFromHome(page)
  await expect(page.locator('.cm-content')).toBeFocused()
  await proveSaved(page, request)
})

test('command palette creation from an open inspector keeps focus in the new editor', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await createFromHome(page)
  await expect(page.locator('.cm-content')).toBeFocused()
  await openIfClosed(
    page.getByRole('button', { name: 'Open document inspector', exact: true }),
    page.getByRole('tab', { name: 'properties', exact: true }),
  )
  await expect(page.getByRole('tab', { name: 'properties', exact: true })).toBeVisible()
  await page.locator('body').press('ControlOrMeta+k')
  await page.getByRole('textbox', { name: 'Search workspace and actions' }).fill('New document')
  await page.getByRole('option', { name: /New document/ }).click()
  await expect(page.locator('.cm-content')).toBeFocused()
  await expect(page.getByRole('dialog', { name: 'Document inspector', exact: true })).not.toBeVisible()
  await proveSaved(page, request)
})
