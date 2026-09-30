import { randomUUID } from 'node:crypto'
import { documentSchema, projectDetailSchema } from '../src/api'
import { expect, test } from './fixtures'

test('capture project and Home artifacts explicitly', async ({ page, request }) => {
  test.skip(process.env.SANGAM_CAPTURE_PROJECTS !== '1', 'Explicit artifact capture only')
  const draft = documentSchema.parse(
    await (
      await request.post('/api/v1/documents', {
        headers: { 'Idempotency-Key': randomUUID() },
        data: {
          title: 'Evaluation draft',
          content:
            '# Model comparison\n\nThe smaller model is enough for our local workload. We still need to check long-context retrieval.',
        },
      })
    ).json(),
  )
  const source = documentSchema.parse(
    await (
      await request.post('/api/v1/documents', {
        headers: { 'Idempotency-Key': randomUUID() },
        data: {
          title: 'Benchmark measurements',
          content: '# Measurements\n\nLatency and recall measurements from the evaluation run.',
        },
      })
    ).json(),
  )
  const project = projectDetailSchema.parse(
    await (
      await request.post('/api/v1/projects', {
        data: { name: 'Embedding comparison', description: 'Choose a model for the local machine.' },
      })
    ).json(),
  )
  try {
    for (const [doc, role] of [
      [draft, 'draft'],
      [source, 'source'],
    ] as const)
      await request.post(`/api/v1/projects/${project.project_id}/documents`, {
        data: { document_id: doc.document_id, role },
      })
    await page.goto('/')
    await page.getByLabel('Switch project').selectOption(project.project_id)
    await expect(page.getByRole('button', { name: 'Resume draft' })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: test.info().outputPath('home.png'), fullPage: true })
    await page.goto(`/projects?project=${project.project_id}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Embedding comparison' })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('project.png'), fullPage: true })
    await page.getByRole('button', { name: 'Add document', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByText('Loading available documents', { exact: true })).not.toBeVisible()
    await page.screenshot({ path: test.info().outputPath('attach-document.png') })
    await page.keyboard.press('Escape')
  } finally {
    await request.delete(`/api/v1/projects/${project.project_id}`)
  }
})
