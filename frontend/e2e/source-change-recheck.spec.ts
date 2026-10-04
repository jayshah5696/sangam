import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Page, APIRequestContext } from '@playwright/test'
import { documentSchema, projectDetailSchema } from '../src/api'
import { expect, test } from './fixtures'

const SCREENSHOT_DIR = path.resolve(process.cwd(), 'output/screenshots/issue-323')

async function captureScreenshot(page: Page, filename: string) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const filePath = path.join(SCREENSHOT_DIR, filename)
  await page.screenshot({ path: filePath, fullPage: false })
  return filePath
}

async function setTheme(page: Page, theme: 'midnight' | 'river' | 'parchment' | 'cobalt') {
  await page.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', t)
    localStorage.setItem(
      'sangam.theme-preferences',
      JSON.stringify({
        theme: t,
        uiFont: 'system',
        uiDensity: 'default',
        editorSize: 'default',
      }),
    )
  }, theme)
  await page.waitForTimeout(100)
}

async function createDocument(
  request: APIRequestContext,
  title: string,
  content: string,
  contentType = 'text/markdown',
) {
  const response = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { title, content, content_type: contentType },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  return documentSchema.parse(await response.json())
}

async function updateDocument(request: APIRequestContext, documentId: string, content: string) {
  const response = await request.patch(`/api/v1/documents/${documentId}`, {
    headers: {
      'Idempotency-Key': randomUUID(),
      'If-Match': '*',
    },
    data: { content },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  return documentSchema.parse(await response.json())
}

async function createProject(
  request: APIRequestContext,
  name: string,
  documents: Array<{ document_id: string; role: 'source' | 'draft' | 'note'; notes?: string }>,
) {
  const response = await request.post('/api/v1/projects', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      name,
      description: 'Research project investigating thermal baseline stability.',
      create_brief: false,
    },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  const project = projectDetailSchema.parse(await response.json())
  for (const doc of documents) {
    const addRes = await request.post(`/api/v1/projects/${project.project_id}/documents`, {
      headers: { 'Idempotency-Key': randomUUID() },
      data: { document_id: doc.document_id, role: doc.role, notes: doc.notes },
    })
    expect(addRes.ok(), await addRes.text()).toBeTruthy()
  }
  return project
}

test.describe('Issue #323 - Recheck source changes and dependent conclusions', () => {
  test('inline draft notice, comparison modal, and project dependencies', async ({
    page,
    request,
  }, testInfo) => {
    // 1. Create source document (v1)
    const sourceV1Content = `# Cold Storage Protocol

Recent benchmark runs established our efficiency baseline.

Cold storage efficiency reached 84% under tested ambient conditions.

Safety margins were maintained across all cycles.
`
    const sourceDoc = await createDocument(request, 'Cold Storage Protocol', sourceV1Content)
    const rev1 = sourceDoc.current_revision_id!

    // 2. Create draft document citing source v1
    const draftContent = `# Research Synthesis

Initial trials established the baseline efficiency.

> Cold storage efficiency reached 84% under tested ambient conditions.
>
> Claim: Storage baseline maintained above 80%

[Source: Cold Storage Protocol](sangam://document/${sourceDoc.document_id}?revision=${rev1})

Future trials will assess thermal expansion across extended operations.
`
    const draftDoc = await createDocument(request, 'Thermal Baseline Synthesis', draftContent)

    // 3. Create project with both documents
    const project = await createProject(request, 'Thermal Stability Investigation', [
      { document_id: sourceDoc.document_id, role: 'source', notes: 'Primary benchmark protocol' },
      {
        document_id: draftDoc.document_id,
        role: 'draft',
        notes: 'Synthesis draft citing cold storage benchmark',
      },
    ])

    // Verify before state: open draft when source has NOT changed
    await page.goto(`/documents/${draftDoc.document_id}`)
    await expect(page.getByRole('textbox', { name: 'Document title' })).toHaveValue(
      'Thermal Baseline Synthesis',
    )
    // No source recheck alert should exist yet
    await expect(page.getByRole('alert', { name: 'Source changed alert' })).toHaveCount(0)

    // Capture "before" screenshot on desktop
    if (testInfo.project.name === 'chromium-desktop') {
      await captureScreenshot(page, 'draft-before-source-changed-river.png')
    }

    // 4. Update the source document to revision 2
    const sourceV2Content = `# Cold Storage Protocol

Recent benchmark runs established our efficiency baseline.

Cold storage efficiency updated to 78% after sensor recalibration.

Safety margins were maintained across all cycles.
`
    const sourceV2 = await updateDocument(request, sourceDoc.document_id, sourceV2Content)
    expect(sourceV2.current_revision_id).not.toBe(rev1)

    // 5. Re-open draft document: Verify inline recheck notice appears!
    await page.goto(`/documents/${draftDoc.document_id}`)
    const initialNoticeAlert = page.getByRole('alert', { name: 'Source changed alert' })
    await expect(initialNoticeAlert).toBeVisible()
    await expect(initialNoticeAlert).toContainText('The source behind this paragraph has changed.')
    await expect(initialNoticeAlert).toContainText('Cold Storage Protocol')

    // Capture "after" screenshot with recheck alert across themes
    if (testInfo.project.name === 'chromium-desktop') {
      for (const theme of ['river', 'midnight', 'parchment', 'cobalt'] as const) {
        await setTheme(page, theme)
        await captureScreenshot(page, `draft-recheck-alert-${theme}.png`)
      }
      await setTheme(page, 'river')
    }

    // 6. Click "Compare the old passage with the new one"
    const compareBtn = initialNoticeAlert.getByRole('button', {
      name: 'Compare the old passage with the new one',
    })
    await compareBtn.click()

    // 7. Verify comparison modal contents
    const modal = page.getByRole('dialog', { name: 'Compare source versions' })
    await expect(modal).toBeVisible()
    await expect(modal).toContainText('Compare source versions: Cold Storage Protocol')
    await expect(modal).toContainText('Storage baseline maintained above 80%')
    await expect(modal).toContainText(
      'Detecting a newer source revision is deterministic. Deciding whether the change invalidates a claim requires judgment and remains a suggestion.',
    )
    await expect(modal).toContainText('Cold storage efficiency reached 84%')
    await expect(modal).toContainText(
      'The original passage was removed or significantly rewritten in the current head revision.',
    )

    // Capture modal screenshots across themes
    if (testInfo.project.name === 'chromium-desktop') {
      for (const theme of ['river', 'midnight', 'parchment', 'cobalt'] as const) {
        await setTheme(page, theme)
        await captureScreenshot(page, `comparison-modal-${theme}.png`)
      }
      await setTheme(page, 'river')
    }

    // Test "Keep original pinned reference"
    const keepBtn = modal.getByRole('button', { name: 'Keep original pinned reference' })
    await keepBtn.click()
    await expect(modal).toHaveCount(0)

    // Reopen modal and test "Revise conclusion"
    await compareBtn.click()
    await expect(modal).toBeVisible()
    const reviseBtn = modal.getByRole('button', { name: 'Revise conclusion' })
    await reviseBtn.click()
    await expect(modal).toHaveCount(0)

    // 8. Test Project Dependencies Inspection View
    await page.goto(`/projects?project=${project.project_id}`)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Thermal Stability Investigation')

    // The project doc row for Cold Storage Protocol should show source updated
    const sourceCard = page.locator('.project-doc-row', {
      hasText: 'Cold Storage Protocol',
    })
    await expect(sourceCard).toBeVisible()
    await expect(sourceCard).toContainText('Source updated')
    await expect(sourceCard).toContainText('Which conclusions in this project depend on this paper? (1)')

    // Expand dependent conclusions
    const toggleDependencies = sourceCard.getByRole('button', {
      name: /Which conclusions in this project depend on this paper\?/,
    })
    // If not already expanded, click to open
    const conclusionCard = sourceCard.locator('.dependent-conclusion-card')
    if (!(await conclusionCard.isVisible())) {
      await toggleDependencies.click()
    }
    await expect(conclusionCard).toBeVisible()
    await expect(conclusionCard).toContainText('Storage baseline maintained above 80%')
    await expect(conclusionCard).toContainText('Needs rechecking · Source updated')

    // Capture project dependencies screenshot across themes
    if (testInfo.project.name === 'chromium-desktop') {
      for (const theme of ['river', 'midnight', 'parchment', 'cobalt'] as const) {
        await setTheme(page, theme)
        await captureScreenshot(page, `project-dependencies-${theme}.png`)
      }
      await setTheme(page, 'river')
    }

    // Click "Compare old and new evidence" from within the project dependencies view
    const projectCompareBtn = conclusionCard.getByRole('button', {
      name: 'Compare old and new evidence',
    })
    await projectCompareBtn.click()

    const projectModal = page.getByRole('dialog', { name: 'Compare source versions' })
    await expect(projectModal).toBeVisible()
    await expect(projectModal).toContainText('Storage baseline maintained above 80%')

    // Close modal via Keep original
    await projectModal.getByRole('button', { name: 'Keep original pinned reference' }).click()
    await expect(projectModal).toHaveCount(0)

    // Click "Mark source reviewed" while on project page
    const markReviewedBtn = sourceCard.getByRole('button', { name: 'Mark source reviewed' })
    await markReviewedBtn.click()
    await expect(sourceCard.locator('.source-recheck-callout')).toHaveCount(0)

    // 9. Go back to draft and test "Update to current head revision"
    await page.goto(`/documents/${draftDoc.document_id}`)
    const returnNoticeAlert = page.getByRole('alert', { name: 'Source changed alert' })
    await expect(returnNoticeAlert).toBeVisible()
    const draftCompareBtn = page.getByRole('button', {
      name: 'Compare the old passage with the new one',
    })
    await draftCompareBtn.click()

    const draftModal = page.getByRole('dialog', { name: 'Compare source versions' })
    await expect(draftModal).toBeVisible()
    const updateBtn = draftModal.getByRole('button', { name: 'Update to current head revision' })
    await expect(updateBtn).toBeEnabled()
    await updateBtn.click()
    await expect(draftModal).toHaveCount(0)

    // Recheck alert should now be gone because the draft citation revision was updated to head
    await expect(page.getByRole('alert', { name: 'Source changed alert' })).toHaveCount(0)
  })
})
