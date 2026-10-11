import { expect, test } from './fixtures'
import { chatMemoryEntrySchema, chatMemoryPageSchema, projectDetailSchema } from '../src/api'

test('chat context stays compact and closing preserves drafts until explicit discard', async ({
  page,
  request,
}) => {
  const factPrefix = `ux-${crypto.randomUUID()}`
  try {
    for (const [index, content] of [
      'My headset is Quest 3',
      'My laptop is Cedar',
      'My keyboard is split',
    ].entries()) {
      const response = await request.put('/api/v1/chat/memory', {
        data: { memory_id: `${factPrefix}-${index}`, content, expected_version: 0 },
      })
      expect(response.ok()).toBeTruthy()
    }
    await page.goto('/chat')
    const trigger = page.getByRole('button', { name: 'Instructions', exact: true })
    await expect(page.getByRole('dialog', { name: 'Chat context' })).not.toBeVisible()
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Chat context' })
    await page.getByText('Saved facts', { exact: true }).click()
    await expect(page.getByRole('button', { name: 'Edit fact', exact: true })).toHaveCount(3)
    await expect(page.getByLabel('Edit fact').first()).not.toBeVisible()
    await page.getByRole('button', { name: 'Edit fact', exact: true }).first().click()
    const editor = page.getByLabel('Edit fact').filter({ visible: true })
    const original = await editor.inputValue()
    await editor.fill('Unsaved headset correction')
    await page.getByRole('button', { name: 'Close fact editor' }).click()
    await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Edit fact', exact: true }).first().click()
    await expect(editor).toHaveValue('Unsaved headset correction')
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(trigger).toBeFocused()
    await trigger.click()
    await expect(editor).toHaveValue('Unsaved headset correction')
    await page.getByRole('button', { name: 'Discard fact changes' }).click()
    await expect(editor).toHaveValue(original)
    await page.getByLabel('Personal instructions').fill('Unsaved preferences')
    await page.getByRole('button', { name: 'Close chat context' }).click()
    await trigger.click()
    await expect(page.getByLabel('Personal instructions')).toHaveValue('Unsaved preferences')
    await page.getByRole('button', { name: 'Discard personal instruction changes' }).click()
    await expect(page.getByLabel('Personal instructions')).toHaveValue('')
    for (const width of [320, 767, 769, 844]) {
      await page.setViewportSize({ width, height: width === 844 ? 390 : 844 })
      await expect
        .poll(async () => {
          const bounds = await dialog.boundingBox()
          return (
            bounds !== null &&
            bounds.x >= 0 &&
            bounds.x + bounds.width <= width &&
            bounds.y >= 0 &&
            bounds.y + bounds.height <= (width === 844 ? 390 : 844)
          )
        })
        .toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    }
    await page.screenshot({ path: test.info().outputPath('chat-context-editor.png') })
    await page.keyboard.press('Escape')
    await page.screenshot({ path: test.info().outputPath('chat-context-closed.png') })
  } finally {
    for (const index of [0, 1, 2]) {
      const response = await request.put('/api/v1/chat/memory', {
        data: {
          memory_id: `${factPrefix}-${index}`,
          action: 'forget',
          content: '',
          expected_version: 1,
        },
      })
      expect(response.ok()).toBeTruthy()
    }
  }
})

test('saved facts survive reload, preserve stale drafts, and forget with cancellation', async ({
  page,
  request,
}) => {
  await page.goto('/chat')
  await page.getByText('Instructions', { exact: true }).click()
  await page.getByText('Saved facts', { exact: true }).click()
  await page.getByText('Add fact', { exact: true }).click()
  await page.getByLabel('Fact to remember').fill('My headset is Quest 3')
  await page.getByRole('button', { name: 'Save fact', exact: true }).click()
  await page.getByRole('button', { name: 'Edit fact', exact: true }).click()
  await expect(page.getByLabel('Edit fact')).toHaveValue('My headset is Quest 3')
  const saved = chatMemoryPageSchema.parse(await (await request.get('/api/v1/chat/memory')).json()).entries[0]
  await page.reload()
  await page.getByText('Instructions', { exact: true }).click()
  await page.getByText('Saved facts', { exact: true }).click()
  await page.getByRole('button', { name: 'Edit fact', exact: true }).click()
  await expect(page.getByLabel('Edit fact')).toHaveValue('My headset is Quest 3')
  const response = await request.put('/api/v1/chat/memory', {
    data: { memory_id: saved.memory_id, content: 'My headset is Quest Pro', expected_version: saved.version },
  })
  expect(response.ok()).toBeTruthy()
  await page.getByLabel('Edit fact').fill('My stale correction')
  await page.getByRole('button', { name: 'Save fact changes' }).click()
  await expect(page.getByText('Memory changed elsewhere', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Edit fact')).toHaveValue('My stale correction')
  await page.getByRole('button', { name: 'Reload saved facts' }).click()
  await expect(page.getByLabel('Edit fact')).toHaveValue('My headset is Quest Pro')
  await page.getByRole('button', { name: 'Forget fact', exact: true }).click()
  await page.getByRole('button', { name: 'Keep fact' }).click()
  await expect(page.getByRole('group', { name: 'Confirm forgetting' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Forget fact', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm forget' }).click()
  await expect(page.getByRole('button', { name: 'Edit fact', exact: true })).toHaveCount(0)
  expect(
    chatMemoryPageSchema.parse(await (await request.get('/api/v1/chat/memory')).json()).entries,
  ).toHaveLength(0)
  await expect(page.getByText('No saved facts', { exact: true })).toBeVisible()
})

test('suggestions require acceptance and explicit project facts remain scoped', async ({ page, request }) => {
  const project = projectDetailSchema.parse(
    await (
      await request.post('/api/v1/projects', { data: { name: 'Memory scope', create_brief: false } })
    ).json(),
  )
  const fact = chatMemoryEntrySchema.parse(
    await (
      await request.put('/api/v1/chat/memory', {
        data: {
          memory_id: `suggest-${project.project_id}`,
          project_id: project.project_id,
          content: 'Atlas uses a Quest 3 headset',
          action: 'suggest',
          expected_version: 0,
        },
      })
    ).json(),
  )
  try {
    await page.goto('/chat')
    await page.getByText('Instructions', { exact: true }).click()
    await page.getByText('Saved facts', { exact: true }).click()
    await expect(page.getByRole('button', { name: 'Edit fact', exact: true })).toHaveCount(0)
    await page.goto(`/chat?project=${project.project_id}`)
    await page.getByText('Instructions', { exact: true }).click()
    await page.getByText('Saved facts', { exact: true }).click()
    await expect(page.getByText('Suggested fact', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Edit fact', exact: true }).click()
    await page.getByRole('button', { name: 'Accept suggestion' }).click()
    await expect(page.getByText('Saved fact', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Edit fact', exact: true }).click()
    for (const width of [320, 844]) {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 390 })
      await expect(page.getByRole('button', { name: 'Forget fact', exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    }
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: test.info().outputPath('saved-facts.png') })
    await page.getByRole('button', { name: 'Forget fact', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm forget' }).click()
    await expect(page.getByLabel('Edit fact')).toHaveCount(0)
  } finally {
    await request.put('/api/v1/chat/memory', {
      data: {
        memory_id: fact.memory_id,
        project_id: project.project_id,
        content: '',
        action: 'forget',
        expected_version: 1,
      },
    })
    await request.delete(`/api/v1/projects/${project.project_id}`)
  }
})
