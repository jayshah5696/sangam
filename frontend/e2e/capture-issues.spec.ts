import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures'

const repositoryRoot = path.resolve(import.meta.dirname, '../..')
const outDir = path.join(repositoryRoot, 'docs/assets/walkthrough')
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true })
}

test.describe('Issue Verification Real Screenshots', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(page.viewportSize()?.width !== 1440, 'Desktop only')
  })

  test('capture issue 60 and 61 (file tree and context menu)', async ({ page, request }) => {
    await request.post('/api/v1/folders', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: { path: 'projects' },
    })
    await request.post('/api/v1/folders', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: { path: 'projects/distributed-systems' },
    })
    await request.post('/api/v1/folders', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: { path: 'projects/distributed-systems/consensus-protocols' },
    })
    const doc = await request.post('/api/v1/documents', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: {
        title: 'Raft & Paxos Comparative Analysis',
        content: '# Raft & Paxos Comparative Analysis\n\nHigh throughput consensus benchmarks.',
        path: 'projects/distributed-systems/consensus-protocols/raft-and-paxos-comparative-study-2026.md',
      },
    })
    await request.post('/api/v1/documents', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: {
        title: 'Distributed Storage Specifications',
        content: '# Storage Specifications\n\nACID persistence and replication.',
        path: 'projects/high-throughput-storage-engine-design-specifications.md',
      },
    })
    const docData = (await doc.json()) as { document_id: string }

    await page.goto(`/documents/${docData.document_id}`)
    await expect(page.locator('.document-header h1')).toHaveText('Raft & Paxos Comparative Analysis')
    await page.waitForTimeout(600)

    // Ensure Files mode is active
    await page.locator('#workspace-tab-files').click()
    await page.waitForTimeout(400)

    // Issue #60: clean single-line truncation with no duplicate text or marker overlays.
    const longDocument = page.locator('.sangam-file-tree').getByRole('treeitem', {
      name: 'raft-and-paxos-comparative-study-2026.md',
    })
    await expect(longDocument).toBeVisible()
    const labelLayout = await longDocument.evaluate((row) => ({
      clientWidth: row.clientWidth,
      scrollWidth: row.scrollWidth,
      visibleText: [...row.querySelectorAll<HTMLElement>('[data-truncate-content="visible"]')]
        .map((node) => node.textContent)
        .join(''),
    }))
    expect(labelLayout.scrollWidth).toBeLessThanOrEqual(labelLayout.clientWidth)
    expect(labelLayout.visibleText).toBe('raft-and-paxos-comparative-study-2026.md')
    await page.locator('.primary-sidebar').screenshot({ path: path.join(outDir, 'issue-60-file-tree.png') })

    // Issue #61: context menu is portaled beyond the sidebar clip and dismisses with Escape.
    await longDocument.click({ button: 'right' })
    const contextMenu = page.getByRole('menu', {
      name: 'Actions for raft-and-paxos-comparative-study-2026.md',
    })
    await expect(contextMenu).toBeVisible()
    await expect(contextMenu.getByRole('menuitem')).toHaveText([
      'Open in split',
      'Rename',
      'Duplicate',
      'Move to trash',
    ])
    const sidebarBox = await page.locator('.primary-sidebar').boundingBox()
    const menuBox = await contextMenu.boundingBox()
    expect(sidebarBox).not.toBeNull()
    expect(menuBox).not.toBeNull()
    expect(menuBox!.x + menuBox!.width).toBeGreaterThan(sidebarBox!.x + sidebarBox!.width)
    await page.screenshot({ path: path.join(outDir, 'issue-61-context-menu.png') })
    await page.keyboard.press('Escape')
    await expect(contextMenu).toBeHidden()
    await expect(longDocument).toBeFocused()
  })

  test('capture issue 62 and 70 (split pane close and 40px tab trigger)', async ({ page, request }) => {
    const doc = await request.post('/api/v1/documents', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: {
        title: 'Cluster Performance Metrics',
        content: '# Cluster Performance Metrics\n\nThroughput metrics across 10 nodes.',
      },
    })
    const docData = (await doc.json()) as { document_id: string }

    await page.goto(`/documents/${docData.document_id}`)
    await expect(page.locator('.document-header h1')).toHaveText('Cluster Performance Metrics')
    await page.waitForTimeout(400)

    // Open Document actions menu and click Split right
    await page.getByRole('button', { name: 'Document actions' }).click()
    await page.getByRole('button', { name: /Split right/ }).click()
    await expect(page.getByRole('tablist', { name: 'Open documents' })).toHaveCount(2)

    // Issue #62: Split panes with close tab and close split controls
    await page
      .locator('.workbench-center')
      .screenshot({ path: path.join(outDir, 'issue-62-split-pane-close.png') })

    // Issue #70: 40px Tab actions trigger aligned with rail
    await page
      .locator('.editor-tabbar')
      .first()
      .screenshot({ path: path.join(outDir, 'issue-70-tab-actions-align.png') })
  })

  test('capture issue 63 and 67 (folder renaming and organization)', async ({ page, request }) => {
    await request.post('/api/v1/folders', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: { path: 'research/quantum-computing' },
    })
    await request.post('/api/v1/documents', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: {
        title: 'Qubit Coherence Study',
        content: '# Qubit Coherence Study\n\nQuantum state fidelity under cryogenic conditions.',
        path: 'research/quantum-computing/qubit-fidelity.md',
      },
    })

    await page.goto('/')
    await page.waitForTimeout(500)
    await page
      .locator('.primary-sidebar')
      .screenshot({ path: path.join(outDir, 'issue-67-folder-organization.png') })
    await page
      .locator('.pierre-tree-shell')
      .screenshot({ path: path.join(outDir, 'issue-63-folder-rename.png') })

    // Issue #100: Context menu Rename on folder must show visible inline input and update path
    const folderItem = page.locator('.sangam-file-tree').getByRole('treeitem', { name: 'quantum-computing' })
    await expect(folderItem).toBeVisible()
    await folderItem.click({ button: 'right' })

    const folderMenu = page.getByRole('menu', { name: 'Actions for quantum-computing' })
    await expect(folderMenu).toBeVisible()
    await folderMenu.getByRole('menuitem', { name: 'Rename' }).click()

    const renameInput = page.locator('.sangam-file-tree').locator('input[data-item-rename-input]')
    await expect(renameInput).toBeVisible()
    await expect(renameInput).toBeFocused()
    await renameInput.fill('advanced-quantum')
    await renameInput.press('Enter')

    await expect(
      page.locator('.sangam-file-tree').getByRole('treeitem', { name: 'advanced-quantum' }),
    ).toBeVisible()

    // Issue #100: F2 rename on file item must show visible inline input and update path
    const docItem = page.locator('.sangam-file-tree').getByRole('treeitem', { name: 'qubit-fidelity.md' })
    await expect(docItem).toBeVisible()
    await docItem.click()
    await page.keyboard.press('F2')

    await expect(renameInput).toBeVisible()
    await expect(renameInput).toBeFocused()
    await renameInput.fill('qubit-analysis.md')
    await renameInput.press('Enter')

    await expect(
      page.locator('.sangam-file-tree').getByRole('treeitem', { name: 'qubit-analysis.md' }),
    ).toBeVisible()

    // Issue #100: Escape cancels rename mode without modifying path
    const renamedDocItem = page
      .locator('.sangam-file-tree')
      .getByRole('treeitem', { name: 'qubit-analysis.md' })
    await renamedDocItem.click()
    await page.keyboard.press('F2')
    await expect(renameInput).toBeVisible()
    await renameInput.fill('qubit-discarded.md')
    await renameInput.press('Escape')
    await expect(renameInput).toBeHidden()
    await expect(renamedDocItem).toBeVisible()
  })

  test('capture issue 64, 66, and 75 (sidebar navigation, search focus, and sync badge)', async ({
    page,
  }) => {
    await page.goto('/')
    await page.waitForTimeout(400)

    // Issue #64 & #75 footer (Karakeep hidden)
    await page.locator('.sidebar-footer').screenshot({ path: path.join(outDir, 'issue-64-sidebar-nav.png') })

    // Issue #66: Search single focus ring
    await page.locator('#workspace-tab-search').click()
    await page.waitForTimeout(300)
    const searchInput = page.locator('.sidebar-search-input input')
    await searchInput.focus()
    await page.waitForTimeout(300)
    await page.locator('.search-panel').screenshot({ path: path.join(outDir, 'issue-66-search-focus.png') })
  })

  test('capture issue 69 (welcome screen format dropdown)', async ({ page }) => {
    await page.goto('/')
    await page.waitForTimeout(400)
    await page.locator('.welcome').screenshot({ path: path.join(outDir, 'issue-69-welcome-format.png') })
  })

  test('capture issue 71, 72, 73, and 74 (outline formatting, jump, bounded workspace, collapsed rail)', async ({
    page,
    request,
  }) => {
    const doc = await request.post('/api/v1/documents', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: {
        title: 'Sangam System Architecture',
        content: `# [Sangam Architecture Guide](https://sangam.dev/docs)

Sangam is a local-first workspace engineered for durability and high-performance editing.

## <span id="storage-engine">Storage Engine & SQLite Consistency</span>

SQLite snapshot journaling with write-ahead logging ensures total ACID durability across all concurrent agent and human edits.

### Transaction Boundary Verification[#](#transaction-boundary-verification "Link to this section")

Every mutation is strictly isolated and validated with cryptographic SHA-256 checksums.

\`\`\`markdown
# This fenced heading must not appear in the outline
\`\`\`

## [Distributed Synchronization Protocol](https://sangam.dev/sync)

Peer-to-peer reconciliation and deterministic merge resolution over local network.

### Performance Benchmarks & Latency

Throughput exceeds 10,000 document index operations per second on NVMe storage.

## <a href="#governance">Security & Token Governance</a>

Cryptographically signed capability tokens with fine-grained path prefixes.`,
        path: 'architecture/overview.md',
      },
    })
    const docData = (await doc.json()) as { document_id: string }

    await page.goto(`/documents/${docData.document_id}`)
    await expect(page.locator('.document-header h1')).toHaveText('Sangam System Architecture')
    await page.waitForTimeout(400)

    // Open inspector if collapsed
    const openInspectorBtn = page.getByRole('button', { name: 'Open document inspector' })
    if (await openInspectorBtn.isVisible()) {
      await openInspectorBtn.click()
      await page.waitForTimeout(400)
    }

    // Switch to Outline tab
    await page.getByRole('tab', { name: 'outline' }).click()
    await page.waitForTimeout(400)

    // Issue #71: clean rendered text, self-link removed, fenced heading ignored.
    await expect(page.getByRole('button', { name: 'Transaction Boundary Verification' })).toBeVisible()
    await expect(page.getByText(/Link to this section/)).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'This fenced heading must not appear in the outline' }),
    ).toHaveCount(0)
    await page
      .locator('.document-inspector')
      .screenshot({ path: path.join(outDir, 'issue-71-clean-outline.png') })

    // Switch to Preview mode
    await page.getByRole('radio', { name: 'preview' }).click()
    await page.waitForTimeout(400)

    // Click outline item to scroll
    const targetHeading = page.getByRole('button', { name: 'Distributed Synchronization Protocol' })
    if (await targetHeading.isVisible()) {
      await targetHeading.click()
      await page.waitForTimeout(400)
    }

    // Issue #72: Outline jump in preview
    await page
      .locator('.document-workspace')
      .screenshot({ path: path.join(outDir, 'issue-72-outline-preview.png') })

    // Issue #73: Bounded workspace
    await page
      .locator('.workbench-main')
      .screenshot({ path: path.join(outDir, 'issue-73-bounded-workspace.png') })

    // Issue #74: Direct triggers on collapsed rail
    const collapseBtn = page.getByRole('button', { name: 'Collapse document inspector' })
    if (await collapseBtn.isVisible()) {
      await collapseBtn.click()
      await page.waitForTimeout(400)
    }
    await page
      .locator('.right-rail')
      .screenshot({ path: path.join(outDir, 'issue-74-collapsed-rail-triggers.png') })
  })

  test('capture issue 65 and 75 (settings persistent sidebar and version card)', async ({ page }) => {
    await page.goto('/settings')
    await page.waitForTimeout(500)

    // Issue #65: Settings keeps the same primary workspace rail and active Settings link.
    const primarySidebar = page.getByRole('complementary', { name: 'Workspace sidebar' })
    await expect(primarySidebar).toBeVisible()
    await expect(primarySidebar.getByRole('link', { name: 'Settings' })).toHaveClass(/active/)
    await expect(page.getByRole('complementary', { name: 'Settings navigation' })).toBeVisible()
    await page.screenshot({ path: path.join(outDir, 'issue-65-settings-sidebar.png'), fullPage: false })

    // Issue #75: installed version and truthful server status in Operations.
    await page.getByRole('button', { name: /Operations/ }).click()
    await expect(page.getByText(/Sangam Server v/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Refresh server status' })).toBeVisible()
    await expect(page.getByText(/Server is healthy/)).toBeVisible()
    await expect(page.getByText(/Up to date/)).toHaveCount(0)
    await page
      .locator('.settings-content')
      .screenshot({ path: path.join(outDir, 'issue-75-version-card.png') })
  })

  test('capture issue 68 (backup management and deletion UI)', async ({ page, request }) => {
    await request.post('/api/v1/backups', {
      headers: { 'Idempotency-Key': randomUUID() },
    })

    await page.goto('/backups')
    const backupCard = page.locator('.backup-card')
    await expect(backupCard).toBeVisible()
    await backupCard.getByRole('button', { name: 'Delete' }).click()
    await expect(backupCard.getByRole('group', { name: 'Confirm backup deletion' })).toBeVisible()
    await expect(backupCard.getByRole('button', { name: 'Confirm delete' })).toBeVisible()
    await expect(backupCard.getByRole('button', { name: 'Cancel' })).toBeVisible()
    await page.locator('.utility-page').screenshot({ path: path.join(outDir, 'issue-68-backup-delete.png') })
  })
})
