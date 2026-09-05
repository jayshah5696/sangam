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

async function createActivity(request: import('@playwright/test').APIRequestContext) {
  const issued = await issueToken(request)
  const accepted = await request.get('/api/v1/documents', {
    headers: { Authorization: `Bearer ${issued.token}` },
  })
  expect(accepted.ok(), await accepted.text()).toBeTruthy()
  const denied = await request.post('/api/v1/documents', {
    headers: {
      Authorization: `Bearer ${issued.token}`,
      'Idempotency-Key': randomUUID(),
    },
    data: { title: 'Denied draft', content: 'private', path: 'outside/denied.md' },
  })
  expect(denied.status()).toBe(403)
  return issued
}

async function createAdditionalDeniedActivity(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  index: number,
) {
  const denied = await request.post('/api/v1/documents', {
    headers: {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': randomUUID(),
    },
    data: {
      title: `Denied draft ${index}`,
      content: 'private',
      path: `outside/denied-${index}-${randomUUID().slice(0, 8)}.md`,
    },
  })
  expect(denied.status()).toBe(403)
}

async function createPublicPublication(request: import('@playwright/test').APIRequestContext) {
  const suffix = randomUUID().slice(0, 8)
  const actorId = `agent:publisher-${suffix}`
  const tokenResponse = await request.post('/api/v1/agent-tokens', {
    data: {
      actor_id: actorId,
      display_name: 'Publication evidence agent',
      label: 'Publication writer',
      scopes: [{ capability: 'publish', path_prefix: 'published' }],
    },
  })
  expect(tokenResponse.ok(), await tokenResponse.text()).toBeTruthy()
  // SAFETY: POST /api/v1/agent-tokens returns an issued token object with a token secret
  const issued = (await tokenResponse.json()) as { token: string }
  const document = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      title: `Public activity evidence ${suffix}`,
      content: '# Public activity evidence\n',
      path: `published/activity-${suffix}.md`,
    },
  })
  expect(document.ok(), await document.text()).toBeTruthy()
  // SAFETY: POST /api/v1/documents returns a document entity with document_id
  const created = (await document.json()) as { document_id: string }
  const publication = await request.post('/api/v1/publications', {
    headers: {
      Authorization: `Bearer ${issued.token}`,
      'Idempotency-Key': randomUUID(),
    },
    data: {
      document_id: created.document_id,
      slug: `activity-${suffix}`,
      access_policy: 'public',
    },
  })
  expect(publication.ok(), await publication.text()).toBeTruthy()
  return actorId
}

async function openActivityFilters(page: import('@playwright/test').Page) {
  const actor = page.getByRole('combobox', { name: 'Agent', exact: true })
  if (!(await actor.isVisible())) await page.locator('.activity-filter-disclosure > summary').click()
}

async function expectActivitySettingsRail(page: import('@playwright/test').Page) {
  const settingsSidebar = page.getByRole('complementary', { name: 'Settings sidebar' })
  if (page.viewportSize()!.width > 1100) {
    await expect(settingsSidebar).toBeVisible()
    await expect(settingsSidebar.getByRole('button', { name: /Agents & access/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
  } else {
    await page.getByRole('button', { name: 'Show settings sidebar' }).click()
    const settingsDrawer = page.getByRole('dialog', { name: 'Settings sidebar' })
    await expect(settingsDrawer).toBeVisible()
    await expect(settingsDrawer.getByRole('button', { name: /Agents & access/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await settingsDrawer.getByRole('button', { name: 'Hide settings sidebar' }).click()
    await expect(settingsDrawer).toBeHidden()
  }
  await expect(page.getByRole('complementary', { name: 'Workspace sidebar' })).toHaveCount(0)
}

function captureBrowserErrors(page: import('@playwright/test').Page) {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
  return errors
}

test('activity date presets and custom boundaries filter the review log', async ({ page, request }) => {
  const browserErrors = captureBrowserErrors(page)
  const issued = await createActivity(request)
  await Promise.all([1, 2, 3].map((index) => createAdditionalDeniedActivity(request, issued.token, index)))
  const publicationActorId = await createPublicPublication(request)
  await page.goto('/activity')
  await expectActivitySettingsRail(page)
  await expect(page.locator('.activity-filter-disclosure')).not.toHaveAttribute('open', '')
  const refresh = page.getByRole('button', { name: 'Refresh activity' })
  await expect(refresh).toBeEnabled()
  await expect(page.getByText(/Refreshing (activity|insights)/)).toHaveCount(0)
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/activity/summary'),
    refresh.click(),
  ])
  await expect(refresh).toBeEnabled()
  await openActivityFilters(page)
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toContainText(
    'Token editor evidence',
  )
  await expect(page.getByRole('combobox', { name: 'Token', exact: true })).toContainText('Research reader')
  const range = page.getByLabel('Activity date range')
  await expect(range).toHaveValue('7d')
  const insightsTab = page.getByRole('tab', { name: 'Insights' })
  const activityTab = page.getByRole('tab', { name: 'Activity' })
  await expect(insightsTab).toHaveAttribute('aria-selected', 'true')
  await insightsTab.focus()
  await insightsTab.press('ArrowRight')
  await expect(activityTab).toHaveAttribute('aria-selected', 'true')
  await activityTab.press('ArrowLeft')
  await expect(insightsTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible()
  await expect(page.locator('.activity-problem')).toHaveCount(3)
  const showMoreProblems = page.getByRole('button', { name: /Show \d+ more/ })
  await expect(showMoreProblems).toBeVisible()
  await showMoreProblems.click()
  await expect.poll(() => page.locator('.activity-problem').count()).toBeGreaterThan(3)
  const showFewerProblems = page.getByRole('button', { name: 'Show fewer' })
  await expect(showFewerProblems).toBeVisible()
  await showFewerProblems.click()
  await expect(page.locator('.activity-problem')).toHaveCount(3)
  await showMoreProblems.click()
  const accessProblem = page.locator('.activity-problem').filter({ hasText: 'Access denied' }).first()
  await expect(accessProblem).toContainText('Research reader · create · forbidden')
  await expect(accessProblem.getByRole('link', { name: 'Manage access' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open public page' }).first()).toBeVisible()
  const problemDescription = await accessProblem.locator('p').innerText()
  await accessProblem.getByRole('button', { name: 'Acknowledge issue' }).click()
  await expect(page.getByRole('button', { name: 'Show acknowledged (1)' })).toBeVisible()
  await page.reload()
  await expect(
    page.locator('.activity-problem:not(.acknowledged)').filter({ hasText: problemDescription }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Show acknowledged (1)' }).click()
  const acknowledgedProblem = page
    .locator('.activity-problem.acknowledged')
    .filter({ hasText: problemDescription })
  await expect(acknowledgedProblem).toBeVisible()
  await acknowledgedProblem.getByRole('button', { name: 'Restore issue' }).click()
  await expect(
    page.locator('.activity-problem:not(.acknowledged)').filter({ hasText: problemDescription }),
  ).toBeVisible()
  await page.getByRole('tab', { name: 'Activity' }).click()
  await openActivityFilters(page)
  await expect(page).toHaveURL(/view=activity/)
  await expect(
    page.locator('.activity-operation').filter({ hasText: 'Token editor evidence' }).first(),
  ).toBeVisible()
  await page.getByRole('combobox', { name: 'Agent', exact: true }).selectOption(publicationActorId)
  await expect(page).toHaveURL(/actor_id=agent%3Apublisher-/)
  await page.reload()
  await openActivityFilters(page)
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveValue(/agent:publisher-/)
  await page.getByRole('button', { name: 'Clear all' }).click()
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveValue('')
  await range.selectOption('7d')
  await expect.poll(() => new URL(page.url()).pathname).toBe('/activity')

  await range.selectOption('custom')
  await page.getByLabel('Since').fill('2099-01-01T00:00')
  await expect(page.getByText('No matching activity')).toBeVisible()
  await page.getByLabel('Until').fill('2098-01-01T00:00')
  await expect(page.getByRole('alert')).toContainText('Start must not be after end')

  const evidenceDir = process.env.SANGAM_EVIDENCE_DIR
  if (evidenceDir) {
    await page.getByRole('tab', { name: 'Insights' }).click()
    await openActivityFilters(page)
    await range.selectOption('7d')
    await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible()
    if (await page.locator('.activity-filter-disclosure').getAttribute('open')) {
      await page.locator('.activity-filter-disclosure > summary').click()
    }
    await page.screenshot({
      path: path.join(evidenceDir, `activity-insights-${test.info().project.name}.png`),
      fullPage: false,
    })
    await page.getByRole('tab', { name: 'Activity' }).click()
    await expect(
      page.locator('.activity-operation').filter({ hasText: 'Token editor evidence' }).first(),
    ).toBeVisible()
    await page.screenshot({
      path: path.join(evidenceDir, `activity-history-${test.info().project.name}.png`),
      fullPage: false,
    })
  }
  expect(browserErrors).toEqual([])
})

test('activity operation details and responsive layout remain usable', async ({ page, request }) => {
  await createActivity(request)
  await page.goto('/activity?view=activity&range=7d')
  await openActivityFilters(page)
  const expandedFilterOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(expandedFilterOverflow).toBe(0)
  const operation = page.locator('.activity-operation').filter({ hasText: 'Token editor evidence' }).first()
  await expect(operation).toBeVisible()
  await operation.getByRole('button', { name: 'Expand details' }).click()
  await expect(operation.locator('.activity-event')).toBeVisible()
  await expect(operation.getByText(/Outcome: denied|denied/).first()).toBeVisible()
  await expect(operation).toContainText('Research reader · 1 denied')
  await expect(operation).toContainText('capability:')
  await operation.getByRole('button', { name: 'Filter operation' }).click()
  await expect(page).toHaveURL(/operation_id=/)
  await page.context().setOffline(true)
  await expect(page.getByText('Activity is offline')).toBeVisible()
  await page.context().setOffline(false)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBe(0)
  if (test.info().project.name === 'chromium-touch-mobile') {
    const filterSummary = page.locator('.activity-filter-disclosure > summary')
    await expect(filterSummary).toBeVisible()
    await filterSummary.click()
    await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toBeHidden()
    await filterSummary.click()
    const minHeight = await operation
      .getByRole('button', { name: 'Hide details' })
      .evaluate((button) => button.getBoundingClientRect().height)
    expect(minHeight).toBeGreaterThanOrEqual(44)
  }
})

test('activity pagination keeps filters in the URL beyond the first page', async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'One desktop run proves pagination mechanics')
  const issued = await issueToken(request)
  for (let index = 0; index < 51; index += 1) {
    const response = await request.get('/api/v1/documents', {
      headers: { Authorization: `Bearer ${issued.token}` },
    })
    expect(response.ok(), await response.text()).toBeTruthy()
  }
  await page.goto(`/activity?view=activity&range=7d&token_id=${issued.token_id}`)
  await openActivityFilters(page)
  await expect(page.getByRole('combobox', { name: 'Token', exact: true })).toContainText('Research reader')
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page).toHaveURL(/page=2/)
  await expect(page.getByRole('combobox', { name: 'Token', exact: true })).toHaveValue(issued.token_id)
  await expect(page.getByText('Page 2')).toBeVisible()
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

test('settings presents access health and one activity handoff', async ({ page, request }) => {
  const browserErrors = captureBrowserErrors(page)
  await createActivity(request)
  await page.goto('/settings?category=agents')
  await expect(page.getByRole('heading', { name: 'Access health' })).toBeVisible()
  await expect(page.getByText(/denied today/)).toBeVisible()
  await expect(page.locator('.token-row').filter({ hasText: 'Token editor evidence' }).first()).toContainText(
    '1 denied request today',
  )
  await expect(page.getByRole('link', { name: 'Open activity' })).toHaveCount(1)
  await expect(page.getByRole('link', { name: 'Review agent activity' })).toHaveCount(0)
  await expect(page.getByText('Tokens, permissions, and access health').first()).toBeVisible()
  const evidenceDir = process.env.SANGAM_EVIDENCE_DIR
  if (evidenceDir) {
    await page.screenshot({
      path: path.join(evidenceDir, `access-health-${test.info().project.name}.png`),
      fullPage: true,
    })
  }
  expect(browserErrors).toEqual([])
})
