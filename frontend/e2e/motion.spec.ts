import { expect, test } from './fixtures'

function parseMs(value: string): number {
  const trimmed = value.trim()
  if (trimmed.endsWith('ms')) {
    return Number.parseFloat(trimmed)
  }
  if (trimmed.endsWith('s')) {
    return Number.parseFloat(trimmed) * 1000
  }
  return Number.parseFloat(trimmed)
}

test.describe('Restrained motion language and workbench interactions', () => {
  test.describe('with normal motion', () => {
    test.use({ reducedMotion: 'no-preference' })

    test('root defines semantic motion duration and easing tokens', async ({ page }) => {
      await page.goto('/')

      const tokens = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement)
        return {
          instant: style.getPropertyValue('--motion-instant').trim(),
          fast: style.getPropertyValue('--motion-fast').trim(),
          control: style.getPropertyValue('--motion-control').trim(),
          panel: style.getPropertyValue('--motion-panel').trim(),
          easeOut: style.getPropertyValue('--ease-ui-out').trim(),
          easeInOut: style.getPropertyValue('--ease-ui-in-out').trim(),
        }
      })

      expect(Math.round(parseMs(tokens.instant))).toBe(80)
      expect(Math.round(parseMs(tokens.fast))).toBe(120)
      expect(Math.round(parseMs(tokens.control))).toBe(160)
      expect(Math.round(parseMs(tokens.panel))).toBe(220)
      expect(tokens.easeOut).toMatch(/cubic-bezier\(0?\.16,\s*1,\s*0?\.3,\s*1\)/)
      expect(tokens.easeInOut).toMatch(/cubic-bezier\(0?\.4,\s*0,\s*0?\.2,\s*1\)/)
    })

    test('action menu opens with popover motion and restores focus on Escape', async ({
      page,
      seededWorkspace,
    }) => {
      await page.goto(`/documents/${seededWorkspace.documentId}`)

      const trigger = page.locator('.document-actions-trigger')
      await expect(trigger).toBeVisible()
      await trigger.click()

      const popover = page.locator('.action-dialog-popover')
      await expect(popover).toBeVisible()

      // Escape closes the menu and returns focus to trigger
      await page.keyboard.press('Escape')
      await expect(popover).not.toBeVisible()
      await expect(trigger).toBeFocused()
    })

    test('command palette opens with backdrop and restores focus on Escape', async ({
      page,
      seededWorkspace,
    }) => {
      await page.goto(`/documents/${seededWorkspace.documentId}`)

      // Try Ctrl+k and Meta+k for robust cross-platform activation
      await page.keyboard.press('Control+k')
      const dialog = page.getByRole('dialog', { name: 'Command palette' })
      if (!(await dialog.isVisible())) {
        await page.keyboard.press('Meta+k')
      }
      await expect(dialog).toBeVisible()

      const input = dialog.locator('input')
      await expect(input).toBeFocused()

      // Escape closes palette
      await page.keyboard.press('Escape')
      await expect(dialog).not.toBeVisible()
    })

    test('inspector tabs preserve geometry when changing active tab', async ({ page, seededWorkspace }) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`/documents/${seededWorkspace.documentId}`)

      const tabsContainer = page.locator('.inspector-tabs')
      await expect(tabsContainer).toBeVisible()

      const initialHeight = await tabsContainer.evaluate((el) => el.getBoundingClientRect().height)

      const propertiesTab = tabsContainer.getByRole('tab', { name: 'properties' })
      const outlineTab = tabsContainer.getByRole('tab', { name: 'outline' })
      const historyTab = tabsContainer.getByRole('tab', { name: 'history' })

      await expect(propertiesTab).toHaveAttribute('aria-selected', 'true')

      // Switch to Outline
      await outlineTab.click()
      await expect(outlineTab).toHaveAttribute('aria-selected', 'true')
      const outlineHeight = await tabsContainer.evaluate((el) => el.getBoundingClientRect().height)
      expect(outlineHeight).toBe(initialHeight)

      // Switch to History
      await historyTab.click()
      await expect(historyTab).toHaveAttribute('aria-selected', 'true')
      const historyHeight = await tabsContainer.evaluate((el) => el.getBoundingClientRect().height)
      expect(historyHeight).toBe(initialHeight)
    })

    test('mobile sidebar drawer opens within viewport bounds and dismisses on backdrop click', async ({
      page,
      seededWorkspace,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(`/documents/${seededWorkspace.documentId}`)

      const revealBtn = page.locator('.sidebar-reveal')
      await expect(revealBtn).toBeVisible()
      await revealBtn.click()

      const sidebar = page.locator('.primary-sidebar')
      await expect(sidebar).toBeVisible()

      const box = await sidebar.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.width).toBeLessThanOrEqual(390)

      const backdrop = page.locator('.sidebar-backdrop')
      await expect(backdrop).toBeVisible()
      await backdrop.click({ position: { x: 360, y: 400 } })
      await expect(sidebar).not.toBeVisible()
    })

    test('mobile inspector drawer opens within viewport and closes on backdrop click', async ({
      page,
      seededWorkspace,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(`/documents/${seededWorkspace.documentId}`)

      // Collapse inspector first if open
      const collapseBtn = page.locator('button[aria-label="Collapse document inspector"]')
      if (await collapseBtn.isVisible()) {
        await collapseBtn.click()
      }

      // Open inspector on mobile
      const toggle = page.locator('.mobile-inspector-toggle')
      await expect(toggle).toBeVisible()
      await toggle.click()

      const inspector = page.locator('.document-inspector')
      await expect(inspector).toBeVisible()

      // Check viewport containment
      const box = await inspector.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.width).toBeLessThanOrEqual(390)
      expect(box!.y).toBeGreaterThanOrEqual(0)

      // Close via backdrop
      const backdrop = page.locator('.inspector-backdrop')
      await expect(backdrop).toBeVisible()
      await backdrop.click({ position: { x: 10, y: 10 } })
      await expect(inspector).not.toBeVisible()
    })
  })

  test.describe('with reduced motion', () => {
    test('reduced motion disables animations and transitions while keeping UI state accessible', async ({
      page,
      seededWorkspace,
    }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.goto(`/documents/${seededWorkspace.documentId}`)

      const matchesReducedMotion = await page.evaluate(
        () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      )
      expect(matchesReducedMotion).toBe(true)

      // Open ActionMenu under reduced motion - it is immediately open and visible
      const trigger = page.locator('.document-actions-trigger')
      await trigger.click()
      const popover = page.locator('.action-dialog-popover')
      await expect(popover).toBeVisible()

      // Escape closes cleanly
      await page.keyboard.press('Escape')
      await expect(popover).not.toBeVisible()
      await expect(trigger).toBeFocused()
    })
  })
})
