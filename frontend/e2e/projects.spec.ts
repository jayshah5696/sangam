import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { projectDetailSchema, documentSchema } from '../src/api'
import { expect, test } from './fixtures'

test('Home keeps the selected project across reload, including an empty project', async ({
  page,
  request,
}) => {
  const name = `Home ${randomUUID()}`
  const response = await request.post('/api/v1/projects', { data: { name, create_brief: false } })
  const project = projectDetailSchema.parse(await response.json())
  try {
    await page.goto('/')
    await page.getByLabel('Switch project').selectOption(project.project_id)
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
    expect((await page.getByRole('heading', { level: 1, name }).boundingBox())?.y).toBeLessThan(80)
    const sidebarTrigger = page.getByRole('button', { name: 'Show workspace sidebar' })
    if (await sidebarTrigger.isVisible()) {
      const triggerBox = await sidebarTrigger.boundingBox()
      const eyebrowBox = await page.locator('.welcome-heading-row .eyebrow').boundingBox()
      expect(
        triggerBox &&
          eyebrowBox &&
          (eyebrowBox.x >= triggerBox.x + triggerBox.width ||
            eyebrowBox.y >= triggerBox.y + triggerBox.height),
      ).toBeTruthy()
    }
    await expect(page.getByRole('link', { name: 'Add sources or a draft' })).toBeVisible()
    await page.reload()
    await expect(page.getByLabel('Switch project')).toHaveValue(project.project_id)
    await page.getByRole('link', { name: 'Add sources or a draft' }).click()
    await expect(page).toHaveURL(new RegExp(`project=${project.project_id}`))
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  } finally {
    await request.delete(`/api/v1/projects/${project.project_id}`)
  }
})

test('Resume restores the selected draft and both split groups, never the purpose brief', async ({
  page,
  request,
}) => {
  const suffix = randomUUID()
  const create = async (title: string, content: string) =>
    documentSchema.parse(
      await (
        await request.post('/api/v1/documents', {
          headers: { 'Idempotency-Key': randomUUID() },
          data: { title, content },
        })
      ).json(),
    )
  const draft = await create(`Draft ${suffix}`, '# Heading\n\nThe smaller model is enough for our task.')
  const source = await create(`Source ${suffix}`, '# Source\n\nBenchmark details.')
  const project = projectDetailSchema.parse(
    await (await request.post('/api/v1/projects', { data: { name: `Comparison ${suffix}` } })).json(),
  )
  try {
    for (const [doc, role] of [
      [draft, 'draft'],
      [source, 'source'],
    ] as const) {
      expect(
        (
          await request.post(`/api/v1/projects/${project.project_id}/documents`, {
            data: { document_id: doc.document_id, role },
          })
        ).ok(),
      ).toBeTruthy()
    }
    const group = (id: string, doc: typeof draft) => ({
      kind: 'group',
      id,
      activeTabId: doc.document_id,
      tabs: [{ documentId: doc.document_id, title: doc.title, pinned: false }],
    })
    const layout = {
      schemaVersion: 1,
      activeGroupId: 'draft-group',
      recentlyClosed: [],
      root: {
        kind: 'split',
        id: 'comparison',
        direction: 'horizontal',
        ratio: 60,
        first: group('draft-group', draft),
        second: group('source-group', source),
      },
    }
    expect(
      (
        await request.patch(`/api/v1/projects/${project.project_id}`, {
          data: { active_document_id: draft.document_id, workbench_state_json: JSON.stringify(layout) },
        })
      ).ok(),
    ).toBeTruthy()
    await page.goto('/')
    await page.getByLabel('Switch project').selectOption(project.project_id)
    await expect(
      page
        .getByRole('region', { name: 'Resume next action' })
        .getByText('The smaller model is enough for our task.', { exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Resume draft' }).click()
    await expect(page).toHaveURL(new RegExp(`/documents/${draft.document_id}`))
    await expect(page.locator('.editor-group')).toHaveCount(2)
    await page.reload()
    await expect(page.locator('.editor-group')).toHaveCount(2)
    await expect(page).toHaveURL(new RegExp(`/documents/${draft.document_id}`))
    await page.goto(`/projects?project=${project.project_id}`)
    await page.getByRole('button', { name: 'Add document', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Add document', exact: true })).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
    await page.screenshot({ path: test.info().outputPath('project-detail.png'), fullPage: true })
  } finally {
    await request.delete(`/api/v1/projects/${project.project_id}`)
  }
})

test('Create from Home attaches the new draft to the selected project', async ({ page, request }) => {
  const name = `Writing ${randomUUID()}`
  const project = projectDetailSchema.parse(
    await (await request.post('/api/v1/projects', { data: { name, create_brief: false } })).json(),
  )
  try {
    await page.goto('/')
    await page.getByLabel('Switch project').selectOption(project.project_id)
    await page.getByRole('button', { name: 'New document', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Markdown', exact: true }).click()
    await expect(page).toHaveURL(/\/documents\//)
    const detail = projectDetailSchema.parse(
      await (await request.get(`/api/v1/projects/${project.project_id}`)).json(),
    )
    expect(detail.documents).toHaveLength(1)
    expect(detail.active_document_id).toBe(detail.documents[0]?.document_id)
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Resume draft' })).toBeVisible()
  } finally {
    await request.delete(`/api/v1/projects/${project.project_id}`)
  }
})

test('Project creation dialog contains focus and restores it on Escape at dense widths', async ({ page }) => {
  for (const [width, height] of [
    [320, 568],
    [719, 740],
    [721, 740],
    [858, 740],
    [860, 740],
    [844, 390],
  ]) {
    await page.setViewportSize({ width: width!, height: height! })
    await page.goto('/projects')
    const trigger = page.getByRole('button', { name: 'New Project', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Create Project' })
    await expect(dialog).toBeVisible()
    const box = await dialog.boundingBox()
    expect(
      box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width! && box.y + box.height <= height!,
    ).toBeTruthy()
    if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) {
      expect(
        (await dialog.getByRole('button', { name: 'Cancel', exact: true }).boundingBox())?.height,
      ).toBeGreaterThanOrEqual(44)
    }
    await expect(page.getByLabel('Project name *')).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBeTruthy()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
    await page.screenshot({ path: test.info().outputPath(`create-${width}.png`) })
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(trigger).toBeFocused()
  }
})

test('Project PDF context overrides a warm reader and survives reload; passages are attachable', async ({
  page,
  request,
}) => {
  const pdf = documentSchema.parse(
    await (
      await request.post(`/api/v1/pdfs?title=Project%20paper&path=research/${randomUUID()}.pdf`, {
        headers: { 'Content-Type': 'application/pdf', 'Idempotency-Key': randomUUID() },
        data: fs.readFileSync(path.join(import.meta.dirname, 'assets/multipage.pdf')),
      })
    ).json(),
  )
  const annotation = z.object({ annotation_id: z.string() }).parse(
    await (
      await request.post(`/api/v1/pdfs/${pdf.document_id}/annotations`, {
        headers: { 'Idempotency-Key': randomUUID() },
        data: {
          page_number: 2,
          annotation_type: 'comment',
          note: 'Compare the benchmark assumptions',
          geometry: [{ x: 0.1, y: 0.1, width: 0.05, height: 0.05 }],
        },
      })
    ).json(),
  )
  const project = projectDetailSchema.parse(
    await (
      await request.post('/api/v1/projects', {
        data: { name: `PDF context ${randomUUID()}`, create_brief: false },
      })
    ).json(),
  )
  try {
    expect(
      (
        await request.post(`/api/v1/projects/${project.project_id}/documents`, {
          data: { document_id: pdf.document_id, role: 'source', pinned_page: 2 },
        })
      ).ok(),
    ).toBeTruthy()
    await page.goto(`/documents/${pdf.document_id}`)
    await expect(page.getByLabel('PDF page number', { exact: true })).toHaveValue('1')
    await page.goto(`/projects?project=${project.project_id}`)
    await page.getByLabel('Attach passage').selectOption(annotation.annotation_id)
    await page.getByRole('button', { name: 'Attach passage', exact: true }).click()
    const passage = page.getByRole('button', { name: /Compare the benchmark assumptions.*Page 2/ })
    await expect(passage).toBeVisible()
    await passage.click()
    await expect(page.getByLabel('PDF page number', { exact: true })).toHaveValue('2')
    await page.reload()
    await expect(page.getByLabel('PDF page number', { exact: true })).toHaveValue('2')
    await page.goto(`/projects?project=${project.project_id}`)
    expect(
      projectDetailSchema.parse(await (await request.get(`/api/v1/projects/${project.project_id}`)).json())
        .annotations,
    ).toHaveLength(1)
  } finally {
    await request.delete(`/api/v1/projects/${project.project_id}`)
  }
})

test('A newer source is project attention and can be acknowledged after inspection', async ({
  page,
  request,
}) => {
  const doc = documentSchema.parse(
    await (
      await request.post('/api/v1/documents', {
        headers: { 'Idempotency-Key': randomUUID() },
        data: { title: `Source update ${randomUUID()}`, content: '# Paper\n\nOriginal findings' },
      })
    ).json(),
  )
  const project = projectDetailSchema.parse(
    await (
      await request.post('/api/v1/projects', {
        data: { name: `Source review ${randomUUID()}`, create_brief: false },
      })
    ).json(),
  )
  try {
    await request.post(`/api/v1/projects/${project.project_id}/documents`, {
      data: { document_id: doc.document_id, role: 'source' },
    })
    expect(
      (
        await request.patch(`/api/v1/documents/${doc.document_id}`, {
          headers: { 'Idempotency-Key': randomUUID() },
          data: { expected_revision_id: doc.current_revision_id, content: '# Paper\n\nUpdated findings' },
        })
      ).ok(),
    ).toBeTruthy()
    await page.goto('/')
    await page.getByLabel('Switch project').selectOption(project.project_id)
    await expect(page.getByRole('region', { name: 'Since your last visit' })).toContainText('Source updated')
    await page.goto(`/projects?project=${project.project_id}`)
    await page.getByRole('button', { name: 'Mark source reviewed' }).click()
    await expect(page.getByText('Source has a newer revision', { exact: true })).not.toBeVisible()
    await page.goto('/')
    await expect(page.getByRole('region', { name: 'Since your last visit' })).not.toBeVisible()
  } finally {
    await request.delete(`/api/v1/projects/${project.project_id}`)
  }
})
