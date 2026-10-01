import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import { documentSchema, projectDetailSchema, publicationSchema } from '../src/api'
import { expect, test } from './fixtures'

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

async function create(request: APIRequestContext, data: { title: string; content: string; path?: string }) {
  const response = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { content_type: 'text/markdown', ...data },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  return documentSchema.parse(await response.json())
}

async function showSidebar(page: Page) {
  const reveal = page.getByRole('button', { name: 'Show workspace sidebar', exact: true })
  if (await reveal.isVisible()) await reveal.click()
}

async function openSearch(page: Page) {
  await showSidebar(page)
  await page.locator('#workspace-tab-search').click()
  return page.getByRole('searchbox', { name: 'Search documents', exact: true })
}

async function closeInspectorSheet(page: Page) {
  const sheet = page.getByRole('dialog', { name: 'Document inspector', exact: true })
  if (await sheet.isVisible())
    await sheet.getByRole('button', { name: 'Collapse document inspector' }).click()
}

async function waitForSaved(page: Page) {
  await expect(page.locator('.save-state')).toHaveText(/^Saved/)
}

test('workspace destinations carry visible labels that match their names', async ({ page }) => {
  await page.goto('/')
  await showSidebar(page)
  const tools = page.getByRole('navigation', { name: 'Workspace tools' })
  for (const [name, label] of [
    ['Projects', 'Projects'],
    ['Workspace chat', 'Chat'],
    ['Review changes', 'Review'],
    ['Publications', 'Publications'],
    ['Trash', 'Trash'],
    ['Settings', 'Settings'],
  ]) {
    const link = tools.getByRole('link', { name, exact: true })
    await expect(link).toBeVisible()
    await expect(link).toContainText(label)
  }
  const overflow = await tools.evaluate((nav) => nav.scrollWidth - nav.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('a search result names the passage and opens the editor on it', async ({ page, request }) => {
  const term = `quokka${randomUUID().slice(0, 6)}`
  const document = await create(request, {
    title: `Evaluation ${term}`,
    content: `# Evaluation\n\nIntro paragraph.\n\n## Hardware requirements\n\nPeak memory for ${term} reached 6.2 GB.\n`,
  })
  await page.goto('/')
  const search = await openSearch(page)
  await search.fill(term)
  const result = page.getByRole('article', { name: `Evaluation ${term}` })
  const passage = result.locator('.search-passage').first()
  await expect(passage).toContainText('Hardware requirements · line 7')
  await expect(passage).toContainText('Matched in document text')
  await expect(passage.locator('mark')).toHaveText(term)
  await passage.click()
  await expect(page).toHaveURL(new RegExp(`/documents/${document.document_id}\\?line=7`))
  await closeInspectorSheet(page)

  // Preview marks the block that holds the passage.
  await page.getByRole('radio', { name: 'preview' }).click()
  await expect(page.locator('.markdown-preview [data-search-target]')).toContainText(
    `Peak memory for ${term}`,
  )

  // The editor selects the matched word on its line.
  await page.getByRole('radio', { name: 'edit' }).click()
  await page.goto('/')
  await (await openSearch(page)).fill(term)
  await page
    .getByRole('article', { name: `Evaluation ${term}` })
    .locator('.search-passage')
    .first()
    .click()
  await closeInspectorSheet(page)
  await expect(page.locator('.cm-line', { hasText: `Peak memory for ${term}` })).toBeInViewport()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(term)
})

test('a saved view keeps its query and filters and reopens from Home', async ({ page, request }) => {
  const term = `walrus${randomUUID().slice(0, 6)}`
  await create(request, { title: `Notes ${term}`, content: `${term} appears here.\n` })
  await page.goto('/')
  const search = await openSearch(page)
  await search.fill(term)
  await page.getByRole('tabpanel').getByLabel('Type').selectOption('text/markdown')
  await page.getByRole('button', { name: 'Save view' }).click()
  const name = page.getByRole('textbox', { name: 'Saved view name' })
  await expect(name).toHaveValue(`“${term}” · Markdown`)
  await name.fill(`Walrus ${term}`)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const views = page.getByRole('region', { name: 'Saved views' })
  await expect(views.getByRole('button', { name: `Walrus ${term}`, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  await page.reload()
  await expect(page.locator('.welcome-saved-views')).toBeVisible()
  const sidebarDialog = page.getByRole('dialog', { name: 'Workspace sidebar' })
  if (await sidebarDialog.isVisible())
    await page.getByRole('button', { name: 'Close workspace sidebar' }).click()
  await page
    .locator('.welcome-saved-views')
    .getByRole('button', { name: `Walrus ${term}` })
    .click()
  await expect(page.getByRole('searchbox', { name: 'Search documents', exact: true })).toHaveValue(term)
  await expect(page.getByRole('article', { name: `Notes ${term}` })).toBeVisible()

  await page.getByRole('button', { name: `Remove saved view Walrus ${term}` }).click()
  await expect(views.getByRole('button', { name: `Walrus ${term}`, exact: true })).toHaveCount(0)
})

test('the header shows when readers see an older revision and publishing is deliberate', async ({
  page,
  request,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const document = await create(request, {
    title: `Published ${suffix}`,
    content: '# First\n',
    path: `published/${suffix}.md`,
  })
  const published = await request.post('/api/v1/publications', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { document_id: document.document_id, slug: `pub-${suffix}`, access_policy: 'public' },
  })
  expect(published.ok(), await published.text()).toBeTruthy()
  const edited = await request.patch(`/api/v1/documents/${document.document_id}`, {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { expected_revision_id: document.current_revision_id, content: '# Second\n' },
  })
  expect(edited.ok()).toBeTruthy()
  const reader = await request.get(`/api/v1/publications/pub-${suffix}/content`)
  expect((await reader.json()).content).toBe('# First\n')

  await page.goto(`/documents/${document.document_id}`)
  const differs = page.getByRole('button', { name: 'Published version differs' })
  await expect(differs).toBeVisible()
  await differs.click()
  await expect(page.locator('.revision-merge-view')).toBeVisible()

  await page.getByRole('tab', { name: 'properties', exact: true }).click()
  await expect(page.getByText('Readers see an earlier revision.')).toBeVisible()
  await page.getByRole('button', { name: 'Publish saved draft' }).click()
  await expect(page.getByText('Readers see the saved draft.')).toBeVisible()
  await closeInspectorSheet(page)
  await expect(page.getByRole('button', { name: 'Published', exact: true })).toBeVisible()
  const status = publicationSchema.parse(
    await (await request.get(`/api/v1/publications/by-document/${document.document_id}`)).json(),
  )
  expect(status.revision_id).toBe(status.document_revision_id)
  expect((await (await request.get(`/api/v1/publications/pub-${suffix}/content`)).json()).content).toBe(
    '# Second\n',
  )
})

test('formatting shortcuts and the selection toolbar edit the selected words', async ({ page, request }) => {
  const document = await create(request, { title: `Format ${randomUUID()}`, content: 'make word bold\n' })
  await page.goto(`/documents/${document.document_id}`)
  await closeInspectorSheet(page)
  await page.getByRole('radio', { name: 'edit' }).click()
  const line = page.locator('.cm-line', { hasText: 'make word bold' })
  await line.click()
  await page.keyboard.press('End')
  for (let index = 0; index < 4; index += 1) await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('ControlOrMeta+b')
  await expect(page.locator('.cm-content')).toContainText('make word **bold**')

  await page.keyboard.press('Home')
  for (let index = 0; index < 4; index += 1) await page.keyboard.press('Shift+ArrowRight')
  const toolbar = page.getByRole('toolbar', { name: 'Selected text actions' })
  await expect(toolbar).toBeVisible()
  await toolbar.getByRole('button', { name: 'Italic' }).click()
  await expect(page.locator('.cm-content')).toContainText('_make_ word **bold**')
  await waitForSaved(page)
  const saved = documentSchema.parse(
    await (await request.get(`/api/v1/documents/${document.document_id}`)).json(),
  )
  expect(saved.content).toBe('_make_ word **bold**\n')
})

test('an added image is stored beside the document and shown in the preview', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8)
  const document = await create(request, {
    title: `Images ${suffix}`,
    content: '# Images\n\n',
    path: `images-${suffix}/note.md`,
  })
  await page.goto(`/documents/${document.document_id}`)
  await closeInspectorSheet(page)
  await page.getByRole('radio', { name: 'edit' }).click()
  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page
    .getByLabel('Add image')
    .setInputFiles({ name: 'Diagram One.png', mimeType: 'image/png', buffer: PNG })
  await expect(page.locator('.cm-content')).toContainText('![Diagram One](assets/diagram-one-')
  await waitForSaved(page)
  await page.getByRole('radio', { name: 'preview' }).click()
  const image = page.locator('.editing-surface .markdown-preview img')
  await expect(image).toHaveAttribute('src', new RegExp(`/api/v1/documents/${document.document_id}/assets`))
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1)
})

test('one capture flow saves text, links, and files to the Inbox and a chosen project', async ({
  page,
  request,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const project = projectDetailSchema.parse(
    await (
      await request.post('/api/v1/projects', { data: { name: `Capture ${suffix}`, create_brief: false } })
    ).json(),
  )
  try {
    await page.goto('/')
    await page.getByRole('button', { name: 'Capture', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Capture to Inbox' })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Text, Markdown, or link').fill(`# Idea ${suffix}\n\nTry the smaller model.`)
    await dialog.getByLabel('Add files to capture').setInputFiles([
      { name: `notes-${suffix}.md`, mimeType: 'text/markdown', buffer: Buffer.from(`# Notes ${suffix}\n`) },
      { name: `shot-${suffix}.png`, mimeType: 'image/png', buffer: PNG },
    ])
    await dialog.getByLabel('Also add to project').selectOption(project.project_id)
    await dialog.getByRole('button', { name: 'Capture', exact: true }).click()
    const results = dialog.getByRole('list', { name: 'Capture results' })
    await expect(results.getByRole('listitem')).toHaveCount(3)
    await expect(results.getByText('Saved', { exact: true })).toHaveCount(3)
    await expect(results.getByText(`Added to Capture ${suffix}.`)).toHaveCount(3)

    await dialog.getByLabel('Text, Markdown, or link').fill('https://example.com/report')
    await expect(dialog.getByText('it does not download the page')).toBeVisible()
    await dialog.getByRole('button', { name: 'Capture', exact: true }).click()
    await expect(results.getByRole('listitem')).toHaveCount(4)
    await expect(results.getByText('Saved', { exact: true })).toHaveCount(4)
    const overflow = await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toBeHidden()

    const inbox = page.getByRole('region', { name: /Inbox/ })
    await expect(inbox.getByRole('link', { name: `Idea ${suffix}` })).toBeVisible()
    const detail = await (await request.get(`/api/v1/projects/${project.project_id}`)).json()
    const memberTitles = JSON.stringify(detail)
    for (const title of [`Idea ${suffix}`, `notes-${suffix}`, `shot-${suffix}`])
      expect(memberTitles).toContain(title)
    const documents = await (await request.get('/api/v1/documents?limit=200')).json()
    const captured = documents.filter((item: { path: string | null }) => item.path?.includes(suffix))
    expect(captured.every((item: { path: string }) => item.path.startsWith('inbox/'))).toBe(true)
    const link = documents.find((item: { title: string }) => item.title === 'example.com/report')
    const linkNote = documentSchema.parse(
      await (await request.get(`/api/v1/documents/${link.document_id}`)).json(),
    )
    expect(linkNote.content).toContain('> Source: <https://example.com/report>')
  } finally {
    await request.delete(`/api/v1/projects/${project.project_id}`)
  }
})
