import { expect, test } from './fixtures'
import { chatProfileContextSchema, projectDetailSchema } from '../src/api'

test('chat profile saves once, reports scope, rejects stale edits and clears', async ({ page, request }) => {
  await page.goto('/chat')
  await page.getByText('Instructions', { exact: true }).click()
  const personal = page.getByLabel('Personal instructions')
  await personal.fill('Keep updates concise')
  await page.getByRole('button', { name: 'Save personal instructions' }).click()
  await expect(page.getByText('Personal instructions saved', { exact: true })).toBeVisible()
  await page.getByLabel('Next turn only').fill('Give a detailed explanation')
  await expect(page.getByText('No project selected', { exact: true })).toBeVisible()
  const current = await request.get('/api/v1/chat/profile')
  const value = chatProfileContextSchema.parse(await current.json())
  await request.put('/api/v1/chat/profile', {
    data: {
      project_id: null,
      content: 'Newer instructions',
      expected_version: value.entries[0].version,
    },
  })
  await personal.fill('Stale draft')
  await page.getByRole('button', { name: 'Save personal instructions' }).click()
  await expect(page.getByText('Instructions changed elsewhere', { exact: true })).toBeVisible()
  await expect(personal).toHaveValue('Stale draft')
  await page.getByRole('button', { name: 'Reload saved instructions' }).click()
  await expect(personal).toHaveValue('Newer instructions')
  await page.getByRole('button', { name: 'Clear personal instructions' }).click()
  await expect(personal).toHaveValue('')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  expect(overflow).toBe(false)
})

test('explicit project instructions stay separate from personal and document chat', async ({
  page,
  request,
  seededWorkspace,
}) => {
  const response = await request.post('/api/v1/projects', {
    data: { name: 'Instruction scope', create_brief: false },
  })
  expect(response.ok()).toBeTruthy()
  const project = projectDetailSchema.parse(await response.json())
  try {
    await page.goto(`/chat?project=${project.project_id}`)
    await page.getByText('Instructions', { exact: true }).click()
    await expect(page.getByText(`Selected project: ${project.project_id}`, { exact: true })).toBeVisible()
    await page.getByLabel('Project instructions').fill('Use the project vocabulary')
    await page.getByRole('button', { name: 'Save project instructions' }).click()
    await expect(page.getByText('Project instructions saved', { exact: true })).toBeVisible()
    await page.reload()
    await page.getByText('Instructions', { exact: true }).click()
    await expect(page.getByLabel('Project instructions')).toHaveValue('Use the project vocabulary')
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: test.info().outputPath('project-instructions.png') })
    await page.goto(`/chat?document=${seededWorkspace.documentId}`)
    await page.getByText('Instructions', { exact: true }).click()
    await expect(page.getByText('No project selected', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Project instructions')).toHaveCount(0)
    for (const width of [320, 844]) {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 390 })
      await expect(page.getByLabel('Personal instructions')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    }
  } finally {
    await request.delete(`/api/v1/projects/${project.project_id}`)
  }
})
