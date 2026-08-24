import AxeBuilder from '@axe-core/playwright'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { expect, test } from './fixtures'

async function expectRenderedIconSize(locator: import('@playwright/test').Locator, expected: number) {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBe(expected)
  expect(box!.height).toBe(expected)
}

test('display type scale stays consistent across routes and editor modes', async ({
  page,
  seededWorkspace,
}) => {
  await page.goto('/')
  const heroSize = await page
    .locator('.welcome h1')
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
  expect(heroSize).toBeGreaterThanOrEqual(36)
  expect(heroSize).toBeLessThanOrEqual(64)

  const publicationSize = await (async () => {
    await page.goto('/publications')
    const header = page.locator('.publication-page > header h1')
    if ((await header.count()) === 0) return null
    return Number.parseFloat(await header.evaluate((element) => getComputedStyle(element).fontSize))
  })()
  if (publicationSize !== null) {
    expect(publicationSize).toBe(heroSize)
  }

  await page.goto(`/documents/${seededWorkspace.documentId}`)
  const header = page.locator('.document-header h1')
  await expect(header).toBeVisible()
  const normalSize = await header.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
  expect(normalSize).toBeGreaterThanOrEqual(22)
  expect(normalSize).toBeLessThanOrEqual(31)

  const splitButton = page.getByRole('tab', { name: 'Split' })
  if (await splitButton.count()) {
    await splitButton.click()
    await expect(page.locator('.split-workbench .document-header h1')).toBeVisible()
    const splitSize = await page
      .locator('.split-workbench .document-header h1')
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
    expect(splitSize).toBe(normalSize)
  }
})

test('typography preferences apply live, persist, and reset', async ({ page }) => {
  await page.goto('/settings?category=appearance')
  const uiFont = page.getByLabel('Interface font')
  await expect(uiFont).toBeVisible()

  await uiFont.selectOption('serif')
  await expect(page.locator('html')).toHaveAttribute('data-ui-font', 'serif')
  const chromeFamily = await page
    .locator('.settings-compact-header h1')
    .evaluate((element) => getComputedStyle(element).fontFamily)
  expect(chromeFamily).toContain('Georgia')

  const controlSizeBefore = await page
    .locator('#typography-ui-font select')
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
  await page.getByRole('button', { name: 'Compact' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-ui-density', 'compact')
  const controlSizeAfter = await page
    .locator('#typography-ui-font select')
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
  expect(controlSizeAfter).toBeLessThan(controlSizeBefore)

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-ui-font', 'serif')
  await expect(page.locator('html')).toHaveAttribute('data-ui-density', 'compact')

  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-ui-font', 'system')
  await expect(page.locator('html')).toHaveAttribute('data-ui-density', 'default')
  await expect(page.locator('html')).toHaveAttribute('data-editor-size', 'default')
})

test('create theme applies a custom accent and clears cleanly', async ({ page }) => {
  await page.goto('/settings?category=appearance')
  const builder = page.locator('#create-theme')
  await expect(builder).toBeVisible()

  await builder.getByLabel('Base palette').selectOption('cobalt')
  await builder.getByLabel('Accent color').fill('#ff8800')
  await builder.getByRole('button', { name: 'Use this theme' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'cobalt')
  const accent = await page.locator('html').evaluate((element) => element.style.getPropertyValue('--accent'))
  expect(accent).toBe('#ff8800')

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'cobalt')
  expect(await page.locator('html').evaluate((element) => element.style.getPropertyValue('--accent'))).toBe(
    '#ff8800',
  )

  await builder.getByRole('button', { name: 'Stop using custom theme' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight')
  expect(await page.locator('html').evaluate((element) => element.style.getPropertyValue('--accent'))).toBe(
    '',
  )
})

test('semantic icon roles render consistently without shrinking control targets', async ({
  page,
}, testInfo) => {
  await page.goto('/publications')
  const tokens = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement)
    return ['--icon-detail', '--icon-inline', '--icon-control', '--icon-section', '--icon-page'].map((name) =>
      styles.getPropertyValue(name).trim(),
    )
  })
  expect(tokens).toEqual(['.75rem', '.875rem', '1rem', '1.125rem', '1.5rem'])
  await expectRenderedIconSize(page.locator('.utility-header > .lucide').first(), 24)
  await expectRenderedIconSize(page.locator('.publication-filters .lucide-search'), 16)

  await page.goto('/settings')
  if (page.viewportSize()?.width !== 1440) {
    await page.getByRole('button', { name: 'Show settings sidebar' }).click()
  }
  await expectRenderedIconSize(page.locator('.settings-search .lucide-search'), 16)

  await page.goto('/')
  await page.locator('body').press('ControlOrMeta+k')
  await expectRenderedIconSize(page.locator('.command-palette > label .lucide-search'), 16)
  await page.getByRole('textbox', { name: 'Search workspace and actions' }).fill('settings')
  await expectRenderedIconSize(
    page.locator('.command-palette').getByRole('option').first().locator('.lucide'),
    14,
  )
  const evidenceDir = process.env.SANGAM_EVIDENCE_DIR
  if (evidenceDir && testInfo.project.name === 'chromium-desktop') {
    await page.screenshot({ path: path.join(evidenceDir, 'issue-119-semantic-icon-roles.png') })
  }
  await page.keyboard.press('Escape')

  const iconButton = page.locator('.icon-button:visible').first()
  if (await iconButton.count()) {
    const target = await iconButton.boundingBox()
    expect(target).not.toBeNull()
    const minimum = test.info().project.name.includes('touch-mobile') ? 44 : 32
    expect(target!.width).toBeGreaterThanOrEqual(minimum)
    expect(target!.height).toBeGreaterThanOrEqual(minimum)
  }
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', page.viewportSize()!.width)
})

test('file tree labels remain bound to their rows through collapse, focus, and rename', async ({
  page,
  request,
}, testInfo) => {
  test.skip(page.viewportSize()?.width !== 1440, 'desktop project only')
  const suffix = randomUUID().slice(0, 6)
  const firstFolder = `agents-${suffix}`
  const secondFolder = `agentic-rl-${suffix}`
  const firstFile = `linux-guide-${suffix}.html`
  const secondFile = `reinforcement-learning-${suffix}.md`
  for (const folder of [firstFolder, secondFolder]) {
    const response = await request.post('/api/v1/folders', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: { path: folder },
    })
    expect(response.ok(), await response.text()).toBeTruthy()
  }
  const activeResponse = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      title: `Linux guide ${suffix}`,
      content: '<h1>Linux guide</h1>',
      content_type: 'text/html',
      path: `${firstFolder}/${firstFile}`,
    },
  })
  const active = (await activeResponse.json()) as { document_id: string }
  await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      title: `RL guide ${suffix}`,
      content: '# Reinforcement learning',
      path: `${secondFolder}/${secondFile}`,
    },
  })

  await page.goto(`/documents/${active.document_id}`)
  await page.locator('#workspace-tab-files').click()
  const tree = page.locator('.sangam-file-tree')
  const agents = tree.getByRole('treeitem', { name: firstFolder, exact: true })
  const agentic = tree.getByRole('treeitem', { name: secondFolder, exact: true })
  await expect(agents).toBeVisible()
  await expect(agentic).toBeVisible()
  if ((await agents.getAttribute('aria-expanded')) !== 'true') await agents.click()
  const linux = tree.getByRole('treeitem', { name: firstFile, exact: true })
  await expect(linux).toBeVisible()
  await expect(linux).toHaveAttribute('aria-selected', 'true')

  await agents.focus()
  if ((await agents.getAttribute('aria-expanded')) === 'true') await agents.press('ArrowLeft')
  await expect(linux).toBeHidden()
  await expect(agentic).toHaveAttribute('aria-label', secondFolder)
  await expect(agentic.locator('[data-truncate-content="visible"]')).toHaveText([
    secondFolder.slice(0, Math.ceil(secondFolder.length / 2)),
    secondFolder.slice(Math.ceil(secondFolder.length / 2)),
  ])
  await agentic.focus()
  await expect(agentic).toBeFocused()
  if ((await agentic.getAttribute('aria-expanded')) === 'true') await agentic.press('ArrowLeft')
  await expect(agentic).toHaveAttribute('aria-expanded', 'false')
  await agentic.press('ArrowRight')
  await expect(tree.getByRole('treeitem', { name: secondFile, exact: true })).toBeVisible()
  await expect(page.locator('.document-header h1')).toHaveText(`Linux guide ${suffix}`)

  await agentic.press('F2')
  const rename = tree.locator('input[data-item-rename-input]')
  await expect(rename).toBeFocused()
  const renamedFolder = `${secondFolder}-reviewed`
  await rename.fill(renamedFolder)
  await rename.press('Enter')
  await expect(tree.getByRole('treeitem', { name: renamedFolder, exact: true })).toBeVisible()
  await expect(tree.locator('[data-sangam-label]')).toHaveCount(0)

  await agents.focus()
  if ((await agents.getAttribute('aria-expanded')) !== 'true') await agents.press('ArrowRight')
  await expect(tree.getByRole('treeitem', { name: firstFile, exact: true })).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: firstFile, exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  const evidenceDir = process.env.SANGAM_EVIDENCE_DIR
  if (evidenceDir) {
    await page.locator('.primary-sidebar').screenshot({
      path: path.join(evidenceDir, `issue-120-file-tree-${testInfo.project.name}.png`),
    })
  }
})

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
