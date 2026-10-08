import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import { z } from 'zod'
import { assignmentSchema, documentSchema } from '../src/api'
import { expect, test } from './fixtures'

async function createDocument(
  request: APIRequestContext,
  content: string,
  title = `Workflow ${randomUUID().slice(0, 8)}`,
) {
  const response = await request.post('/api/v1/documents', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { title, content },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  return documentSchema.parse(await response.json())
}

async function inspectorTab(page: Page, name: 'research' | 'history') {
  const tab = page.getByRole('tab', { name, exact: true })
  const opener = page.getByRole('button', { name: 'Open document inspector', exact: true })
  await expect(opener.or(tab).filter({ visible: true }).first()).toBeVisible()
  if (!(await tab.isVisible())) await opener.click()
  await tab.click()
}

async function readDocument(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/v1/documents/${id}`)
  expect(response.ok(), await response.text()).toBeTruthy()
  return documentSchema.parse(await response.json())
}

test('claim matrix inspects passages, persists stance and exports the actual table', async ({
  page,
  request,
  context,
  browserName,
}, testInfo) => {
  const source = await createDocument(request, '# Source\n\nThe measured latency was 12 ms.')
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(`/documents/${source.document_id}`)
  await page.getByRole('radio', { name: 'preview', exact: true }).click()
  const passage = page.locator('.editing-surface .markdown-preview p').first()
  await expect(passage).toHaveText('The measured latency was 12 ms.')
  await passage.selectText()
  await passage.dispatchEvent('pointerup')
  await page.getByRole('button', { name: 'Keep as evidence', exact: true }).click()
  await page.keyboard.press('Escape')
  await inspectorTab(page, 'research')
  const card = page.getByRole('article', { name: `Evidence from ${source.title}` })
  await card.getByRole('button', { name: '+ Attach to a claim', exact: true }).click()
  await card.getByLabel('Claim statement').fill('Latency is below 15 ms.')
  await card.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: 'Claim matrix view', exact: true }).click()
  const table = page.getByRole('table', { name: 'Claims and supporting sources' })
  await table.getByRole('button', { name: /Claim: Latency is below 15 ms/ }).click()
  const details = page.getByRole('dialog', { name: 'Evidence & Stance Details' })
  await expect(details).toContainText('The measured latency was 12 ms.')
  await details.getByRole('button', { name: 'Challenges', exact: true }).click()
  await details.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(table.getByRole('button', { name: /Status: Challenges/ })).toBeVisible()
  if (browserName === 'chromium') {
    await page.getByRole('button', { name: 'Copy markdown matrix' }).click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`| Claim | ${source.title} |\n| --- | --- |\n| Latency is below 15 ms. | Challenges |`)
  } else {
    testInfo.annotations.push({
      type: 'unverified',
      description: 'WebKit clipboard permissions are not supported by Playwright.',
    })
  }
  await page.reload()
  await inspectorTab(page, 'research')
  await page.getByRole('button', { name: 'Claim matrix view', exact: true }).click()
  await expect(table.getByRole('button', { name: /Status: Challenges/ })).toBeVisible()
  await page.locator('.claim-matrix-view').screenshot({
    path: testInfo.outputPath('claim-matrix.png'),
    animations: 'disabled',
    scale: 'css',
  })
})

test('alternative candidate preserves the original and applies a new persisted revision', async ({
  page,
  request,
  browserName,
}, testInfo) => {
  const original = await createDocument(request, '# Original\n\nRetain this conclusion until reviewed.')
  await page.goto(`/documents/${original.document_id}`)
  await inspectorTab(page, 'history')
  const explore = page.getByRole('button', { name: 'Explore alternative conclusions', exact: true })
  await explore.click()
  const dialog = page.getByRole('dialog', { name: 'Explore Alternative Conclusions' })
  await dialog.getByLabel('Alternative conclusion hypothesis').fill('Lower cost')
  const created = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/v1/documents'),
  )
  await dialog.getByRole('button', { name: 'Create candidate draft' }).click()
  const candidate = documentSchema.parse(await (await created).json())
  expect((await readDocument(request, original.document_id)).current_revision_id).toBe(
    original.current_revision_id,
  )
  await dialog.getByRole('button', { name: 'Open candidate', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/documents/${candidate.document_id}`))
  await expect(page.getByRole('textbox', { name: 'Document title', exact: true })).toHaveValue(
    candidate.title,
  )
  const sheet = page.getByRole('dialog', { name: 'Document inspector', exact: true })
  if (await sheet.isVisible())
    await sheet.getByRole('button', { name: 'Collapse document inspector' }).click()
  await page.getByRole('radio', { name: 'edit', exact: true }).click()
  const candidateContent = '# Alternative\n\nThe lower-cost option needs another experiment.'
  const editor = page.locator('.cm-content')
  await expect(editor).toContainText('Retain this conclusion until reviewed.')
  await editor.click()
  await editor.press(browserName === 'webkit' ? 'Meta+A' : 'ControlOrMeta+A')
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain('Retain this conclusion until reviewed.')
  await page.keyboard.insertText(candidateContent)
  await expect
    .poll(async () => (await readDocument(request, candidate.document_id)).content)
    .toBe(candidateContent)
  expect((await readDocument(request, original.document_id)).content).toBe(original.content)
  await page.goto(`/documents/${original.document_id}`)
  await inspectorTab(page, 'history')
  await explore.click()
  await dialog.getByRole('button', { name: 'Compare assumptions and arguments' }).click()
  await expect(dialog.locator('.revision-merge-view')).toContainText('lower-cost option')
  await dialog.getByRole('button', { name: 'Bring selected changes back to original' }).click()
  await expect(dialog).toContainText('Changes applied to original draft')
  const updated = await readDocument(request, original.document_id)
  expect(updated.content).toBe(candidateContent)
  expect(updated.current_revision_id).not.toBe(original.current_revision_id)
  const historical = await request.get(
    `/api/v1/documents/${original.document_id}/revisions/${original.current_revision_id}`,
  )
  expect(historical.ok(), await historical.text()).toBeTruthy()
  expect(z.object({ content: z.string() }).parse(await historical.json()).content).toBe(original.content)
  await dialog.screenshot({
    path: testInfo.outputPath('alternative-draft.png'),
    animations: 'disabled',
    scale: 'css',
  })
})

test('attached explanation persists source inputs and keeps untrusted scripts inert', async ({
  page,
  request,
}, testInfo) => {
  const document = await createDocument(
    request,
    '# Model\n\nUnit cost is an assumption, not a measured result.',
  )
  await page.goto(`/documents/${document.document_id}`)
  await inspectorTab(page, 'research')
  await page.getByRole('button', { name: 'Attach interactive explanation' }).click()
  const dialog = page.getByRole('dialog', { name: 'Attach Interactive Explanation' })
  await dialog.getByLabel('Explanation Title').fill('Cost assumption')
  await dialog
    .getByLabel('HTML & Script Content')
    .fill('<p>Monthly cost: $3000</p><script>document.body.textContent="SCRIPT EXECUTED"</script>')
  await dialog
    .getByLabel('Input Assumption Passage')
    .fill('Unit cost is an assumption, not a measured result.')
  await dialog.getByRole('button', { name: 'Attach Explanation', exact: true }).click()
  await expect(dialog).toBeHidden()
  const attachment = page.getByRole('article', { name: 'Cost assumption', exact: true })
  const frame = attachment.locator('iframe')
  await expect(frame).toHaveAttribute('sandbox', '')
  await expect(frame.contentFrame().locator('body')).toHaveText('Monthly cost: $3000')
  await attachment.getByRole('tab', { name: 'Source Inputs (1)' }).click()
  await expect(attachment).toContainText(document.title)
  await expect(attachment).toContainText('Unit cost is an assumption, not a measured result.')
  await page.reload()
  await inspectorTab(page, 'research')
  await attachment.getByRole('tab', { name: 'Source Inputs (1)' }).click()
  await expect(attachment).toContainText('Unit cost is an assumption, not a measured result.')
  await attachment.screenshot({
    path: testInfo.outputPath('explanation-source-inputs.png'),
    animations: 'disabled',
    scale: 'css',
  })
  await attachment.getByRole('button', { name: 'Remove explanation' }).click()
  await expect(attachment).toBeHidden()
  expect((await readDocument(request, document.document_id)).content).toBe(document.content)
})

test('document assignment start and stop persist through the real HTTP service', async ({
  page,
  request,
}, testInfo) => {
  const document = await createDocument(request, '# Evidence\n\nCPU latency is 12 ms.')
  await page.goto(`/documents/${document.document_id}`)
  await inspectorTab(page, 'research')
  const rail = page.locator('.document-assignments-rail')
  await rail.getByRole('button', { name: 'Check claims', exact: true }).click()
  await rail.getByRole('textbox').fill('Check the measured CPU latency.')
  await rail.getByRole('button', { name: 'Run review', exact: true }).click()
  await expect(rail).toContainText('Check the measured CPU latency.')
  // The isolated fixture disables remote inference. This proves controls, not model execution.
  await expect(rail).toContainText('Failed')
  await rail.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(rail).toContainText('Stopped')
  await page.reload()
  await inspectorTab(page, 'research')
  await expect(rail).toContainText('Stopped')
  await expect(rail.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0)
  const response = await request.get(`/api/v1/documents/${document.document_id}/assignments`)
  expect(response.ok(), await response.text()).toBeTruthy()
  const assignments = z.array(assignmentSchema).parse(await response.json())
  expect(assignments).toHaveLength(1)
  expect(assignments[0]?.status).toBe('stopped')
  expect(assignments[0]?.document_ids).toEqual([document.document_id])
  expect((await readDocument(request, document.document_id)).content).toBe(document.content)
  await rail.screenshot({
    path: testInfo.outputPath('document-assignment-stopped.png'),
    animations: 'disabled',
    scale: 'css',
  })
})

test('alternative draft controls fit narrow dialogs with long labels and comfortable typography', async ({
  page,
  request,
}, testInfo) => {
  const original = await createDocument(
    request,
    '# Original\n\nKeep this draft.',
    `Long candidate ${'Title'.repeat(20)}`,
  )
  await page.goto(`/documents/${original.document_id}`)
  await inspectorTab(page, 'history')
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-ui-font', 'serif')
    document.documentElement.setAttribute('data-ui-density', 'comfortable')
  })
  await page.getByRole('button', { name: 'Explore alternative conclusions', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Explore Alternative Conclusions' })
  await dialog.getByLabel('Alternative conclusion hypothesis').fill('Hypothesis'.repeat(7))
  await dialog.getByRole('button', { name: 'Create candidate draft' }).click()
  const open = dialog.getByRole('button', { name: 'Open candidate', exact: true })
  await expect(open).toBeVisible()
  for (const width of [769, 767, 390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await expect
      .poll(() =>
        dialog.evaluate((element) => {
          const box = element.getBoundingClientRect()
          return box.left >= 0 && box.right <= innerWidth && element.scrollWidth <= element.clientWidth + 1
        }),
      )
      .toBe(true)
    for (const name of [
      'Create candidate draft',
      'Compare assumptions and arguments',
      'Open candidate',
      'Discard candidate',
    ]) {
      const control = dialog.getByRole('button', { name, exact: true })
      await control.scrollIntoViewIfNeeded()
      await expect
        .poll(() =>
          control.evaluate((element) => {
            const box = element.getBoundingClientRect()
            return box.left >= 0 && box.right <= innerWidth
          }),
        )
        .toBe(true)
    }
    await dialog.screenshot({
      path: testInfo.outputPath(`alternative-layout-${width}.png`),
      animations: 'disabled',
      scale: 'css',
    })
  }
  await open.click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('textbox', { name: 'Document title', exact: true })).toHaveValue(
    `${original.title} (${'Hypothesis'.repeat(7)})`,
  )
  expect((await readDocument(request, original.document_id)).content).toBe(original.content)
})
