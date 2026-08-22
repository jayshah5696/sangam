import { expect, test } from '@playwright/test'

const deployedOrigin = process.env.SANGAM_DEPLOYED_CHAT_ORIGIN
const smokePrompt = process.env.SANGAM_DEPLOYED_CHAT_PROMPT ?? `Reply with SANGAM_CHAT_SMOKE_OK`

test.describe('configured deployment chat', () => {
  test.skip(!deployedOrigin, 'Set SANGAM_DEPLOYED_CHAT_ORIGIN to run the deployment smoke test.')
  test.skip(({ viewport }) => viewport?.width === 390, 'Run the external deployment smoke once on desktop.')

  test('sends a prompt and receives streamed assistant text', async ({ page }) => {
    await page.goto(new URL('/chat', deployedOrigin).toString())
    const chatkit = page.locator('openai-chatkit')
    await expect(chatkit).toBeVisible({ timeout: 30_000 })
    const chatFrame = page.frameLocator('openai-chatkit iframe')
    const composer = chatFrame.getByPlaceholder('Ask about this workspace…')
    await expect(composer).toBeVisible({ timeout: 30_000 })
    await composer.fill(smokePrompt)
    await composer.press('Enter')
    await expect(chatFrame.getByText(smokePrompt, { exact: true })).toBeVisible()
    await expect(chatFrame.getByText('SANGAM_CHAT_SMOKE_OK', { exact: false })).toBeVisible({
      timeout: 120_000,
    })
  })
})
