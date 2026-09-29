import { expect, test } from './fixtures'

test('creating a Markdown draft opens the editor with the cursor ready', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create Markdown' }).click()

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

  await page.getByRole('radio', { name: 'preview' }).click()
  await page.reload()
  await expect(page.getByRole('radio', { name: 'preview' })).toHaveAttribute('aria-checked', 'true')
})

test('creating an HTML draft from Home opens it ready to write', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Format').selectOption('text/html')
  await page.getByRole('button', { name: 'Create HTML' }).click()

  await expect(page.getByRole('radio', { name: 'edit' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('.cm-content')).toBeFocused()
  await expect(page.locator('.cm-content')).toContainText('<!doctype html>')
})

test('creating a draft from the command palette opens it ready to write', async ({ page }) => {
  await page.goto('/')
  await page.locator('body').press('ControlOrMeta+k')
  await page.getByRole('textbox', { name: 'Search workspace and actions' }).fill('New document')
  await page.getByRole('option', { name: /New document/ }).click()

  await expect(page.getByRole('radio', { name: 'edit' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('.cm-content')).toBeFocused()
})

test('creating a workspace file opens it ready to write', async ({ page }) => {
  await page.goto('/')
  const reveal = page.getByRole('button', { name: 'Show workspace sidebar' })
  if (await reveal.isVisible()) await reveal.click()
  await page.locator('#workspace-tab-files').click()
  await page.getByRole('button', { name: 'New file' }).click()
  await page.getByRole('textbox', { name: 'New file path' }).fill(`notes/new-${crypto.randomUUID()}.md`)
  await page.locator('.explorer-create').getByRole('button', { name: 'Create' }).click()

  await expect(page.getByRole('radio', { name: 'edit' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('.cm-content')).toBeFocused()
})
