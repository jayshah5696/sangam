import { expect, test } from './fixtures'

test('review inbox is reachable and explains an empty queue', async ({ page }) => {
  await page.goto('/review')

  await expect(page.getByRole('heading', { name: 'Review changes' })).toBeVisible()
  await expect(page.getByText('Nothing needs review')).toBeVisible()
  const revealSidebar = page.getByRole('button', { name: 'Show workspace sidebar' })
  if (await revealSidebar.isVisible()) await revealSidebar.click()
  await expect(page.getByRole('link', { name: 'Review changes' })).toHaveClass(/active/)
})

test('editorial review card displays 4 editorial questions, supporting passages, and edit mode', async ({
  page,
  seededWorkspace,
}) => {
  const proposal = {
    proposal_id: 'prop-e2e-1',
    document_id: seededWorkspace.documentId,
    thread_id: 'thread-e2e-1',
    expected_revision_id: 'rev-0',
    applied_revision_id: null,
    content: '# Updated Product Review\n\nEditorial review enables thoughtful oversight.',
    summary: 'Update heading and core principles',
    rationale: 'Align with the new editorial workflow requirements',
    judgment_needed: 'Check if the tone fits our internal guidelines',
    status: 'pending',
    evidence_status: 'recorded',
    evidence: null,
    citations: [
      {
        document_id: seededWorkspace.documentId,
        title: 'Product Strategy Q3',
        path: 'strategy/q3.md',
        snippet: 'Editorial oversight is mandatory for generative changes.',
        location: 'paragraph 2',
        evidence_status: 'recorded',
      },
    ],
    sources_retrieved: [
      {
        document_id: seededWorkspace.documentId,
        title: 'Background Research',
        path: 'research/notes.md',
        evidence_status: 'recorded',
      },
    ],
    created_at: new Date().toISOString(),
    applied_at: null,
  }

  await page.route('**/api/v1/chat/proposals**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([proposal]),
      })
    } else {
      await route.continue()
    }
  })

  await page.goto('/review')

  // Check 4 questions
  await expect(page.getByText(seededWorkspace.documentTitle)).toBeVisible()
  await expect(page.getByText('Align with the new editorial workflow requirements')).toBeVisible()
  await expect(page.getByText('Update heading and core principles')).toBeVisible()
  await expect(page.getByText('Check if the tone fits our internal guidelines')).toBeVisible()

  // Supporting passages and retrieved sources
  await expect(page.getByText('Supporting passages')).toBeVisible()
  await expect(page.getByText('Product Strategy Q3')).toBeVisible()
  await expect(page.getByText('Editorial oversight is mandatory for generative changes.')).toBeVisible()
  await expect(page.getByText('Background Research')).toBeVisible()

  // Test edit proposed wording
  await page.getByRole('button', { name: 'Edit wording' }).click()
  const textarea = page.getByLabel('Editable proposed wording')
  await expect(textarea).toBeVisible()
  await textarea.fill('# Updated Product Review\n\nEditorial review edited by reviewer.')
  await expect(page.getByText('Edited', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reset to proposal' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply edited change' })).toBeVisible()

  // Reset back to original
  await page.getByRole('button', { name: 'Reset to proposal' }).click()
  await expect(page.getByText('Edited', { exact: true })).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply change' })).toBeVisible()
})
