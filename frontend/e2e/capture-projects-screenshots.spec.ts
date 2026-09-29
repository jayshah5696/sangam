import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { expect, test } from './fixtures'

test('capture projects UI screenshots for PR visual validation', async ({
  page,
  request,
  seededWorkspace,
}) => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../..')
  const isNarrow = page.viewportSize()?.width === 390

  // 1. Seed two realistic documents
  const doc1Res = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      title: 'Architectural Decisions & Invariants',
      path: 'docs/architecture-invariants.md',
      content:
        '# Architectural Invariants\n\n1. Immutable audit logs.\n2. Projects link documents purely by reference without copies.\n3. Workbench layouts snapshot accurately.',
    },
  })
  // SAFETY: POST /api/v1/documents returns created document with document_id
  const doc1 = (await doc1Res.json()) as { document_id: string }

  const doc2Res = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      title: 'Performance Benchmark Results',
      path: 'benchmarks/latency-report.md',
      content:
        '# Latency Benchmarks\n\n- Project listing p95: 12ms\n- Single project detail p95: 3.8ms\n- Concurrency isolation verified.',
    },
  })
  // SAFETY: POST /api/v1/documents returns created document with document_id
  const doc2 = (await doc2Res.json()) as { document_id: string }

  // 2. Create primary project
  const p1Res = await request.post('/api/v1/projects', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      name: 'Multi-Model Synthesis Core',
      description:
        'Persistent research initiative evaluating cross-model synthesis, live streaming protocols, and shared workspace context.',
      create_brief: true,
    },
  })
  // SAFETY: POST /api/v1/projects returns created project with project_id
  const p1 = (await p1Res.json()) as { project_id: string }

  // Add document references
  await request.post(`/api/v1/projects/${p1.project_id}/documents`, {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      document_id: doc1.document_id,
      role: 'draft',
      notes: 'Active design specifications and invariant rules.',
    },
  })
  await request.post(`/api/v1/projects/${p1.project_id}/documents`, {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      document_id: doc2.document_id,
      role: 'output',
      notes: 'Empirical benchmark evidence validating query speed.',
    },
  })
  await request.post(`/api/v1/projects/${p1.project_id}/documents`, {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      document_id: seededWorkspace.documentId,
      role: 'source',
      pinned_page: 3,
      notes: 'Reference document for domain modeling standards.',
    },
  })

  // Create second project
  await request.post('/api/v1/projects', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      name: 'Distributed Consensus Engine',
      description:
        'Raft state machine replication and partition recovery evaluation for multi-agent coordination.',
      create_brief: true,
    },
  })

  if (!isNarrow) {
    // Desktop 1: Home page showing Projects launcher
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Pick up where you left off.' })).toBeVisible()
    await page.waitForTimeout(500)
    await page.screenshot({
      path: path.join(repositoryRoot, 'docs/assets/pr-331/after-home-launcher.png'),
      fullPage: false,
    })

    // Desktop 2: Projects route grid view
    await page.goto('/projects')
    await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible()
    await page.waitForTimeout(500)
    await page.screenshot({
      path: path.join(repositoryRoot, 'docs/assets/pr-331/after-projects-grid.png'),
      fullPage: false,
    })

    // Desktop 3: Project detail view
    const card = page.locator('article').filter({ hasText: 'Multi-Model Synthesis Core' })
    await card.getByRole('button', { name: 'Manage', exact: true }).click()
    await expect(
      page.getByRole('heading', {
        name: 'Multi-Model Synthesis Core',
        level: 1,
      }),
    ).toBeVisible()
    await page.waitForTimeout(500)
    await page.screenshot({
      path: path.join(repositoryRoot, 'docs/assets/pr-331/after-project-detail.png'),
      fullPage: false,
    })

    // Desktop 4: Add Document Modal
    await page.getByRole('button', { name: 'Add document', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Add Document to Project' })).toBeVisible()
    await page.waitForTimeout(400)
    await page.screenshot({
      path: path.join(repositoryRoot, 'docs/assets/pr-331/after-add-document-modal.png'),
      fullPage: false,
    })
  } else {
    // Mobile: Projects route on narrow viewport
    await page.goto('/projects')
    await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible()
    await page.waitForTimeout(500)
    await page.screenshot({
      path: path.join(repositoryRoot, 'docs/assets/pr-331/after-projects-mobile.png'),
      fullPage: false,
    })
  }
})
