import AxeBuilder from '@axe-core/playwright'

import { expect, test } from './fixtures'

test('settings search opens and focuses the exact setting', async ({ page }) => {
  await page.goto('/settings')

  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()
  await expect(page.locator('.theme-card[aria-pressed="true"]')).toHaveCount(1)

  const search = page.getByRole('searchbox', { name: 'Search settings' })
  await search.fill('sidebar')
  await expect(page.getByRole('option', { name: /Workspace sidebar/ })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await search.press('Enter')

  await expect(page.getByRole('heading', { name: 'Workbench', exact: true })).toBeVisible()
  await expect(page.locator('#workspace-sidebar')).toBeFocused()
})

test('every workspace theme preserves settings contrast', async ({ page }) => {
  await page.goto('/settings')

  for (const theme of ['Midnight', 'River', 'Parchment', 'Cobalt']) {
    await page.getByRole('button', { name: new RegExp(theme) }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.toLowerCase())
    await page.waitForTimeout(200)
    const results = await new AxeBuilder({ page }).withTags(['wcag2aa']).analyze()
    expect(results.violations, `${theme}: ${formatViolations(results.violations)}`).toEqual([])
  }
})

test('workspace switchboard searches documents and action-only mode', async ({ page, seededWorkspace }) => {
  await page.goto('/')
  await page.locator('body').press('ControlOrMeta+k')

  const switchboard = page.getByRole('textbox', { name: 'Search workspace and actions' })
  await expect(switchboard).toBeFocused()
  await switchboard.fill(seededWorkspace.documentTitle)
  await expect(page.getByRole('option', { name: new RegExp(seededWorkspace.documentTitle) })).toBeVisible()
  await switchboard.press('Enter')
  await expect(page.getByRole('heading', { name: seededWorkspace.documentTitle })).toBeVisible()

  await page.locator('body').press('ControlOrMeta+k')
  await page.getByRole('textbox', { name: 'Search workspace and actions' }).fill('> settings')
  await expect(page.getByRole('option', { name: /Open settings/ })).toBeVisible()
  await expect(page.getByText('Documents', { exact: true })).toHaveCount(0)
})

test('document workbench exposes active, save, and inspector state', async ({ page, seededWorkspace }) => {
  await page.goto(`/documents/${seededWorkspace.documentId}`)

  await expect(page.getByRole('heading', { name: seededWorkspace.documentTitle })).toBeVisible()
  await expect(page.locator('.save-state')).toHaveText('Saved')
  await expect(page.getByRole('radio', { name: 'edit' })).toBeChecked()
  await expect(page.getByRole('tab', { name: 'properties' })).toHaveAttribute('aria-selected', 'true')

  await page.getByRole('radio', { name: 'preview' }).click()
  await expect(page.getByRole('radio', { name: 'preview' })).toBeChecked()
  await expect(page.getByRole('heading', { name: 'Product review' })).toBeVisible()
})

test('primary routes have no detectable WCAG A or AA violations', async ({ page }) => {
  for (const route of ['/', '/settings', '/activity', '/reconciliation', '/backups', '/trash']) {
    await page.goto(route)
    await expect(page.locator('h1')).toBeVisible()
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(results.violations, `${route}: ${formatViolations(results.violations)}`).toEqual([])
  }
})

test('narrow settings and workbench reflow without horizontal clipping', async ({
  page,
  seededWorkspace,
}) => {
  test.skip(page.viewportSize()?.width !== 390, 'narrow project only')

  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()
  await expectNoHorizontalOverflow(page)

  await page.goto(`/documents/${seededWorkspace.documentId}`)
  await expect(page.getByRole('button', { name: 'Show workspace sidebar' })).toBeVisible()
  await expect(page.getByRole('heading', { name: seededWorkspace.documentTitle })).toBeVisible()
  await expectNoHorizontalOverflow(page)

  await page.getByRole('button', { name: 'Show workspace sidebar' }).click()
  await expect(page.getByRole('dialog', { name: 'Workspace sidebar' })).toBeVisible()
})

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)
}

function formatViolations(violations: Array<{ id: string; help: string; nodes: unknown[] }>) {
  return violations
    .map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.length} nodes)`)
    .join('\n')
}
