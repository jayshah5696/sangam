import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures'

test.describe('Projects workspace and membership management', () => {
  test('creates a project, manages documents and restores layout', async ({ page, seededWorkspace }) => {
    // 1. Visit projects route
    await page.goto('/projects')
    await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible()

    // 2. Open project creation dialog
    const newProjectBtn = page.getByRole('button', { name: /New Project/i })
    await expect(newProjectBtn).toBeVisible()
    await newProjectBtn.click()

    await expect(page.getByRole('heading', { name: 'Create Project', level: 2 })).toBeVisible()

    // 3. Fill in project form
    const projectName = `Research Project ${randomUUID().slice(0, 6)}`
    await page.getByLabel(/Project name/i).fill(projectName)
    await page.getByLabel(/Purpose & Goals/i).fill('Exploring multi-model synthesis architectures.')

    // Submit creation - this automatically opens project detail view
    await page.getByRole('button', { name: 'Create Project', exact: true }).click()

    // 4. Verify project detail view opens
    await expect(page.getByRole('heading', { name: projectName, level: 1 })).toBeVisible()
    await expect(page.getByText('Exploring multi-model synthesis architectures.')).toBeVisible()

    // Verify auto-generated brief card is present
    await expect(page.getByRole('heading', { name: 'Project Brief', level: 2 })).toBeVisible()

    // 5. Link seeded document to project
    await page.getByRole('button', { name: /Add Document/i }).click()
    await expect(page.getByRole('heading', { name: 'Add Document to Project' })).toBeVisible()

    // Select document, role Draft, and add notes
    await page.getByLabel(/Select document/i).selectOption(seededWorkspace.documentId)
    await page.getByLabel(/Project Role/i).selectOption('draft')
    await page.getByLabel(/Notes \/ Takeaways/i).fill('Primary research draft.')

    // Save
    await page.getByRole('button', { name: 'Add to Project' }).click()

    // Verify document shows in project documents list
    await expect(page.getByText(seededWorkspace.documentTitle)).toBeVisible()
    await expect(page.getByText('Primary research draft.')).toBeVisible()

    // 6. Snapshot current layout
    const snapshotBtn = page.getByRole('button', {
      name: /Snapshot current layout/i,
    })
    await expect(snapshotBtn).toBeVisible()
    await snapshotBtn.click()

    // 7. Back to projects list and test resume
    await page.getByRole('button', { name: 'Back to projects' }).click()
    await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible()

    // Verify card in projects list
    await expect(page.getByRole('main').getByRole('button', { name: projectName, exact: true })).toBeVisible()

    // Resume project from card
    const resumeBtn = page.getByRole('button', { name: 'Resume' }).first()
    await expect(resumeBtn).toBeVisible()
    await resumeBtn.click()

    // Should navigate into document workbench
    await expect(page).toHaveURL(/\/documents\//)
  })

  test('home page displays project launcher and connects to projects route', async ({ page, request }) => {
    // Create a project via API
    const projectName = `API Launched Project ${randomUUID().slice(0, 6)}`
    const res = await request.post('/api/v1/projects', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: {
        name: projectName,
        description: 'Testing home page launcher integration.',
      },
    })
    expect(res.ok()).toBeTruthy()

    // Visit home page
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Pick up where you left off.' })).toBeVisible()

    // Verify Projects section in home main content
    const mainContent = page.getByRole('main', { name: 'Workspace content' })
    await expect(mainContent.getByRole('link', { name: 'Projects', exact: true })).toBeVisible()
    await expect(mainContent.getByText(projectName).first()).toBeVisible()

    // Click Projects navigation link in sidebar
    const revealSidebar = page.getByRole('button', {
      name: 'Show workspace sidebar',
    })
    if (await revealSidebar.isVisible()) {
      await revealSidebar.click()
    }
    const projectsNavLink = page
      .getByRole('navigation', { name: 'Workspace tools' })
      .getByRole('link', { name: 'Projects' })
    await expect(projectsNavLink).toBeVisible()
    await projectsNavLink.click()

    await expect(page).toHaveURL('/projects')
    await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible()
  })
})
