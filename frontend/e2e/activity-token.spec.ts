import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { expect, test } from './fixtures'

async function issueToken(request: import('@playwright/test').APIRequestContext) {
  const response = await request.post('/api/v1/agent-tokens', {
    data: {
      actor_id: `agent:editor-${randomUUID().slice(0, 8)}`,
      display_name: 'Token editor evidence',
      label: 'Research reader',
      scopes: [{ capability: 'read', path_prefix: 'research' }],
    },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  // SAFETY: POST /api/v1/agent-tokens returns issued token object with token_id and token secret
  return (await response.json()) as { token_id: string; token: string }
}

test('activity date presets and custom boundaries filter the review log', async ({ page, request }) => {
  const issued = await issueToken(request)
  const activity = await request.get('/api/v1/documents', {
    headers: { Authorization: `Bearer ${issued.token}` },
  })
  expect(activity.ok(), await activity.text()).toBeTruthy()
  await page.goto('/activity')
  const range = page.getByLabel('Activity date range')
  await expect(range).toHaveValue('all')
  await range.selectOption('7d')
  await expect.poll(() => new URL(page.url()).pathname).toBe('/activity')
  await expect(
    page.locator('.activity-event').filter({ hasText: 'Token editor evidence' }).first(),
  ).toBeVisible()

  await range.selectOption('custom')
  await page.getByLabel('Since').fill('2099-01-01T00:00')
  await expect(page.getByText('No matching activity')).toBeVisible()
  await page.getByLabel('Until').fill('2098-01-01T00:00')
  await expect(page.getByRole('alert')).toContainText('Start must not be after end')

  const evidenceDir = process.env.SANGAM_EVIDENCE_DIR
  if (evidenceDir) {
    await range.selectOption('7d')
    await page.screenshot({ path: path.join(evidenceDir, 'activity.png'), fullPage: false })
  }
})

test('issued token offers separate secret and agent setup handoffs', async ({ page }) => {
  await page.goto('/settings?category=agents')
  await page.getByLabel('Actor ID').fill(`agent:onboarding-${randomUUID().slice(0, 8)}`)
  await page.getByRole('button', { name: 'Issue token' }).click()

  const dialog = page.getByRole('dialog', { name: 'New agent token secret' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Copy token' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Copy agent setup' })).toBeVisible()
  await expect(dialog).toContainText('This value will not be shown again')
})

test('active agent token metadata and scopes can be edited in place', async ({ page, request }) => {
  await issueToken(request)
  await page.goto('/settings?category=agents')
  const token = page.locator('.token-row').filter({ hasText: 'Token editor evidence' }).first()
  await token.getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit Research reader' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Existing secret stays valid after saving')
  await dialog.getByLabel('Token label').fill('Incident reviewer')
  await dialog.getByRole('checkbox', { name: 'search' }).check()
  await dialog.getByLabel('Search path prefix').fill('research')
  await dialog.getByRole('button', { name: 'Save token' }).click()

  await expect(dialog).toBeHidden()
  await expect(token).toContainText('Incident reviewer')
  await expect(token).toContainText('search:/research/**')

  const evidenceDir = process.env.SANGAM_EVIDENCE_DIR
  if (evidenceDir) {
    await token.getByRole('button', { name: 'Edit' }).click()
    await page.screenshot({ path: path.join(evidenceDir, 'token-editor.png'), fullPage: false })
  }
})
