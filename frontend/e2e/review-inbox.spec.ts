import { expect, test } from './fixtures'

test('review inbox is reachable and explains an empty queue', async ({ page }) => {
  await page.goto('/review')

  await expect(page.getByRole('heading', { name: 'Review changes' })).toBeVisible()
  await expect(page.getByText('Nothing needs review')).toBeVisible()
  const revealSidebar = page.getByRole('button', { name: 'Show workspace sidebar' })
  if (await revealSidebar.isVisible()) await revealSidebar.click()
  await expect(page.getByRole('link', { name: 'Review changes' })).toHaveClass(/active/)
})
