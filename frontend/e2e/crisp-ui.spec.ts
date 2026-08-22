import AxeBuilder from '@axe-core/playwright'

import { expect, test } from './fixtures'

test('settings replaces the workspace rail while preserving width and returning cleanly', async ({
  page,
}) => {
  test.skip(page.viewportSize()?.width !== 1440, 'desktop project only')

  await page.goto('/')
  const workspaceSidebar = page.getByRole('complementary', { name: 'Workspace sidebar' })
  await expect(workspaceSidebar).toBeVisible()
  const workspaceWidth = await workspaceSidebar.evaluate((element) => element.getBoundingClientRect().width)

  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  const settingsSidebar = page.getByRole('complementary', { name: 'Settings sidebar' })
  await expect(settingsSidebar).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Workspace sidebar' })).toHaveCount(0)
  await expect(settingsSidebar).toHaveCSS('width', `${workspaceWidth}px`)
  await expect(page.locator('.settings-control-center')).toHaveCSS('display', 'block')

  const resizeHandle = page.getByRole('separator', { name: 'Resize left sidebar' })
  await resizeHandle.focus()
  await resizeHandle.press('ArrowRight')
  await expect(settingsSidebar).toHaveCSS('width', `${workspaceWidth + 10}px`)
  await page.reload()
  await expect(page.getByRole('complementary', { name: 'Settings sidebar' })).toHaveCSS(
    'width',
    `${workspaceWidth + 10}px`,
  )

  await page.getByRole('button', { name: 'Back to workspace' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(workspaceSidebar).toBeVisible()
  await expect(workspaceSidebar).toHaveCSS('width', `${workspaceWidth + 10}px`)

  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.locator('body').press('Escape')
  await expect(page).toHaveURL(/\/$/)

  await page.goto('/settings')
  await page.getByRole('button', { name: 'Back to workspace' }).click()
  await expect(page).toHaveURL(/\/$/)
})

test('settings search opens and focuses the exact setting', async ({ page }) => {
  await page.goto('/settings')

  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()
  await expect(page.locator('.theme-card[aria-pressed="true"]')).toHaveCount(1)

  if (page.viewportSize()?.width !== 1440) {
    await page.getByRole('button', { name: 'Show settings sidebar' }).click()
  }
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

test('settings categories survive reload and support browser history', async ({ page }) => {
  await page.goto('/settings?category=agents')
  await expect(page.getByRole('heading', { name: 'Agents & access', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/category=agents/)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Agents & access', exact: true })).toBeVisible()

  if (page.viewportSize()?.width !== 1440) {
    await page.getByRole('button', { name: 'Show settings sidebar' }).click()
  }
  await page.getByRole('button', { name: /Operations/ }).click()
  await expect(page).toHaveURL(/category=operations/)
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Agents & access', exact: true })).toBeVisible()
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
  await expect(page.getByRole('radio', { name: 'preview' })).toBeChecked()
  const inspectorToggle = page.getByRole('button', { name: 'Open document inspector' })
  if (await inspectorToggle.isVisible()) {
    await inspectorToggle.click()
  }
  await expect(page.getByRole('tab', { name: 'properties' })).toHaveAttribute('aria-selected', 'true')
  if (await inspectorToggle.isVisible()) {
    await page.getByRole('button', { name: 'Collapse document inspector' }).click()
  }

  await page.getByRole('radio', { name: 'preview' }).click()
  await expect(page.getByRole('radio', { name: 'preview' })).toBeChecked()
  await expect(page.getByRole('heading', { name: 'Product review' })).toBeVisible()
})

test('primary routes have no detectable WCAG A or AA violations', async ({ page }) => {
  const routes = test.info().project.name.includes('touch-mobile')
    ? ['/settings', '/reconciliation']
    : ['/', '/chat', '/publications', '/settings', '/activity', '/reconciliation', '/backups', '/trash']
  for (const route of routes) {
    await page.goto(route)
    await expect(page.locator('h1')).toBeVisible()
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(results.violations, `${route}: ${formatViolations(results.violations)}`).toEqual([])
  }
})

test('settings exposes operational destinations and the compact footer keeps only primary tools', async ({
  page,
}) => {
  test.skip(page.viewportSize()?.width !== 1440, 'desktop project only')

  await page.goto('/')
  const tools = page.getByRole('navigation', { name: 'Workspace tools' })
  await expect(tools.getByRole('link')).toHaveCount(4)
  await expect(tools.getByRole('link', { name: 'Workspace chat' })).toBeVisible()
  await expect(tools.getByRole('link', { name: 'Publications' })).toBeVisible()
  await expect(tools.getByRole('link', { name: 'Trash' })).toBeVisible()
  await expect(tools.getByRole('link', { name: 'Settings' })).toBeVisible()
  await expect(page.getByText('Synced', { exact: true })).toHaveCount(0)
  await expect(page.locator('.workspace-freshness')).toHaveCount(0)

  await page.goto('/settings?category=agents')
  await expect(page.getByRole('link', { name: 'Review activity' })).toHaveAttribute('href', '/activity')

  await page.getByRole('button', { name: /Operations/ }).click()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Operations', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Review conflicts' })).toHaveAttribute(
    'href',
    '/reconciliation',
  )
  await expect(page.getByRole('link', { name: 'Manage backups' })).toHaveAttribute('href', '/backups')
})

test('sidebar status distinguishes connectivity, refresh, and integrity conflicts', async ({ page }) => {
  test.skip(page.viewportSize()?.width !== 1440, 'desktop project only')

  await page.route('**/api/v1/reconciliation', async (route) => {
    await route.fulfill({
      json: {
        repaired_document_ids: [],
        conflicts: [
          {
            conflict_id: 'conflict-1',
            conflict_type: 'unknown_file',
            document_id: null,
            path: 'outside.md',
            candidate_path: null,
            expected_hash: null,
            actual_hash: 'abc',
            status: 'open',
            created_at: '2026-08-22T00:00:00Z',
            resolved_at: null,
          },
        ],
      },
    })
  })
  await page.goto('/')
  await expect(page.getByRole('link', { name: '1 unresolved workspace conflicts' })).toBeVisible()

  await page.unroute('**/api/v1/reconciliation')
  await page.context().setOffline(true)
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await expect(page.getByRole('status')).toContainText('Offline')
  await page.context().setOffline(false)
})

test('settings switches between fixed rail and drawer at the 1100px breakpoint', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium-desktop', 'desktop Chromium only')

  await page.setViewportSize({ width: 1101, height: 800 })
  await page.goto('/settings')
  await expect(page.getByRole('complementary', { name: 'Settings sidebar' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Show settings sidebar' })).toHaveCount(0)

  await page.setViewportSize({ width: 1099, height: 800 })
  await expect(page.getByRole('complementary', { name: 'Settings sidebar' })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Show settings sidebar' })).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

test('touch-mobile settings uses the workspace drawer and footer navigation closes it', async ({ page }) => {
  test.skip(!test.info().project.name.includes('touch-mobile'), 'touch-mobile project only')

  await page.goto('/settings')
  await expect(page.getByRole('button', { name: 'Show settings sidebar' })).toBeVisible()
  await page.getByRole('button', { name: 'Show settings sidebar' }).click()
  const sidebar = page.getByRole('dialog', { name: 'Settings sidebar' })
  await expect(sidebar).toBeVisible()
  await expect(sidebar.getByRole('button', { name: 'Back to workspace' })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await sidebar.getByRole('button', { name: 'Hide settings sidebar' }).click()
  await expect(sidebar).toBeHidden()

  await page.goto('/')
  await page.getByRole('button', { name: 'Show workspace sidebar' }).click()
  const workspaceSidebar = page.getByRole('dialog', { name: 'Workspace sidebar' })
  await workspaceSidebar.getByRole('link', { name: 'Trash' }).click()
  await expect(page).toHaveURL(/\/trash$/)
  await expect(workspaceSidebar).toBeHidden()
})

test('narrow settings and workbench reflow without horizontal clipping', async ({
  page,
  seededWorkspace,
}) => {
  test.skip(page.viewportSize()?.width !== 390, 'narrow project only')

  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Show settings sidebar' })).toBeVisible()
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

test('preview is the default editor mode and a chosen mode persists', async ({ page, seededWorkspace }) => {
  await page.goto(`/documents/${seededWorkspace.documentId}`)
  await expect(page.getByRole('radio', { name: 'preview' })).toBeChecked()

  await page.getByRole('radio', { name: 'edit' }).click()
  await expect(page.getByRole('radio', { name: 'edit' })).toBeChecked()
  await page.reload()
  await expect(page.getByRole('radio', { name: 'edit' })).toBeChecked()
})

test('home page searches documents inline and opens the top result', async ({ page, seededWorkspace }) => {
  await page.goto('/')
  const quickSearch = page.getByRole('searchbox', { name: 'Quick search documents' })
  await expect(quickSearch).toBeVisible()
  await quickSearch.fill(seededWorkspace.documentTitle)
  await expect(page.getByRole('listitem').first()).toContainText(seededWorkspace.documentTitle)
  await quickSearch.press('Enter')
  await expect(page.getByRole('heading', { name: seededWorkspace.documentTitle })).toBeVisible()
})

test('slash focuses workspace search from anywhere', async ({ page }) => {
  await page.goto('/')
  await page.locator('body').press('/')
  const sidebarSearch = page.getByRole('searchbox', { name: 'Search documents', exact: true })
  await expect(sidebarSearch).toBeVisible()
  await expect(sidebarSearch).toBeFocused()
})
