import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures'

const repositoryRoot = path.resolve(import.meta.dirname, '../..')
const outDir = path.join(repositoryRoot, 'docs/assets/pr-332')
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true })
}

test.describe('Workspace Evidence UI Screenshots', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(page.viewportSize()?.width !== 1440, 'Desktop only')
  })

  test('capture before and after evidence UI states', async ({ page, request }) => {
    // 1. Create source document
    const sourceRes = await request.post('/api/v1/documents', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: {
        title: 'Consensus Systems & Fault Tolerance',
        content: `# Consensus Systems & Fault Tolerance\n\nState machine replication requires consistent ordering of commands across distributed nodes.\n\nRaft achieves consensus by electing a distinguished leader, then giving the leader complete responsibility for managing the replicated log.\n\nLeader election provides total order across cluster state machines without complex two-phase commit overhead.`,
        path: 'research/consensus-systems.md',
      },
    })
    // SAFETY: POST returns document entity
    const sourceDoc = (await sourceRes.json()) as { document_id: string; current_revision_id: string }

    // 2. Create target draft document
    const draftRes = await request.post('/api/v1/documents', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: {
        title: 'Architecture Review Draft',
        content: `# Architecture Review Draft\n\nThis document outlines our consensus requirements for the 2026 storage platform.\n\n## 1. Executive Summary\n\nWe require linearizable reads and high-availability leader failover under network partitions.`,
        path: 'drafts/architecture-review.md',
      },
    })
    // SAFETY: POST returns document entity
    const draftDoc = (await draftRes.json()) as { document_id: string }

    // 3. Before state: Open draft with standard inspector
    await page.goto(`/documents/${draftDoc.document_id}`)
    await expect(page.locator('.document-header h1')).toHaveText('Architecture Review Draft')
    await page.waitForTimeout(600)

    // Ensure inspector is visible
    const inspector = page.locator('.document-inspector')
    if (!(await inspector.isVisible())) {
      const toggle = page.getByRole('button', { name: /Open document inspector/i })
      if (await toggle.isVisible()) {
        await toggle.click()
        await page.waitForTimeout(400)
      }
    }

    // Switch to info tab for clean before snapshot
    const infoTab = page.getByRole('tab', { name: /^info$/i })
    if (await infoTab.isVisible()) {
      await infoTab.click()
      await page.waitForTimeout(400)
    }

    await page.screenshot({
      path: path.join(outDir, 'before-evidence-rail.png'),
      fullPage: false,
    })

    // 4. Seed workspace evidence in localStorage
    await page.evaluate(
      ({ sourceId, revId }) => {
        localStorage.setItem(
          'sangam-workspace-evidence',
          JSON.stringify([
            {
              id: 'ev-1',
              sourceDocumentId: sourceId,
              sourceTitle: 'Consensus Systems & Fault Tolerance',
              sourceContentType: 'text/markdown',
              pinnedRevisionId: revId,
              selectedText:
                'Raft achieves consensus by electing a distinguished leader, then giving the leader complete responsibility for managing the replicated log.',
              claim: 'Leader election provides total order across cluster state machines.',
              note: 'Primary reference for section 2 consensus invariant.',
              createdAt: new Date().toISOString(),
            },
            {
              id: 'ev-2',
              sourceDocumentId: sourceId,
              sourceTitle: 'Consensus Systems & Fault Tolerance',
              sourceContentType: 'text/markdown',
              pinnedRevisionId: revId,
              selectedText:
                'State machine replication requires consistent ordering of commands across distributed nodes.',
              claim: null,
              note: null,
              createdAt: new Date().toISOString(),
            },
          ]),
        )
      },
      { sourceId: sourceDoc.document_id, revId: sourceDoc.current_revision_id },
    )

    // Reload draft to pick up evidence and open research tab
    await page.goto(`/documents/${draftDoc.document_id}`)
    await expect(page.locator('.document-header h1')).toHaveText('Architecture Review Draft')
    await page.waitForTimeout(600)

    // Open research tab in inspector
    const researchTab = page.getByRole('tab', { name: /^research$/i })
    await expect(researchTab).toBeVisible()
    await researchTab.click()
    await page.waitForTimeout(600)

    // Verify workspace evidence rail is rendered
    await expect(page.getByText('Workspace evidence')).toBeVisible()
    await expect(page.getByText('Raft achieves consensus by electing a distinguished leader')).toBeVisible()

    // 5. After state: Workspace Evidence Rail active
    await page.screenshot({
      path: path.join(outDir, 'after-workspace-evidence-rail.png'),
      fullPage: false,
    })

    // 5b. Capture text selection toolbar with 'Keep as evidence'
    await page.goto(`/documents/${sourceDoc.document_id}`)
    await expect(page.locator('.document-header h1')).toHaveText('Consensus Systems & Fault Tolerance')
    const paragraph = page.locator('article p').nth(1)
    await paragraph.selectText()
    await paragraph.dispatchEvent('mouseup')
    await page.waitForTimeout(400)
    await page.screenshot({
      path: path.join(outDir, 'after-text-selection-keep-evidence.png'),
      fullPage: false,
    })

    // 6. Test comparison modal: click compare on first card, then second card
    const compareButtons = page.locator('.workspace-evidence-rail').getByRole('button', { name: 'Compare' })
    await compareButtons.first().click()
    await page.waitForTimeout(300)

    // Click compare on second card
    await compareButtons.nth(1).click()
    await page.waitForTimeout(400)

    const modal = page.getByRole('dialog', { name: 'Compare evidence excerpts' })
    await expect(modal).toBeVisible()

    // 7. Modal state: Side-by-side excerpt comparison
    await page.screenshot({
      path: path.join(outDir, 'after-evidence-comparison-modal.png'),
      fullPage: false,
    })
  })
})
