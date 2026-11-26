import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { z } from 'zod'

import { expect, test } from './fixtures'

test('token settings and MCP setup have separate destinations and copy actions', async ({
  browserName,
  context,
  page,
}, testInfo) => {
  await page.goto('/settings?category=agents')
  const setup = page.getByRole('region', { name: 'MCP setup', exact: true })
  await expect(setup.getByLabel('MCP server URL')).toBeVisible()
  if (testInfo.project.name === 'chromium-desktop') {
    await page.screenshot({ path: testInfo.outputPath('agents-access-settings.png'), scale: 'css' })
  }
  const sidebarButton = page.getByRole('button', { name: 'Show settings sidebar' })
  if (await sidebarButton.isVisible()) await sidebarButton.click()
  const search = page.getByRole('searchbox', { name: 'Search settings' })
  await search.fill('Agent tokens')
  await search.press('Enter')
  const tokens = page.getByRole('region', { name: 'Agent tokens', exact: true })
  await expect(tokens).toBeFocused()
  await expect(tokens.getByRole('heading', { name: 'MCP setup' })).toHaveCount(0)
  await tokens.getByLabel('Actor ID').fill(`agent:mcp-onboarding-${randomUUID().slice(0, 8)}`)
  const issue = tokens.getByRole('button', { name: 'Issue token' })
  await issue.press('Enter')

  const popup = page.getByRole('dialog', { name: 'New agent token secret' })
  await expect(popup.getByRole('button', { name: 'Copy token' })).toBeVisible()
  await expect(popup).toContainText('This value will not be shown again')
  const guides = popup.getByRole('group', { name: 'Client setup' })
  const mcp = guides.getByRole('button', { name: 'Copy MCP setup', exact: true })
  const rest = guides.getByRole('button', { name: 'Copy REST setup', exact: true })
  await expect(mcp).toBeVisible()
  await expect(rest).toBeVisible()
  if (testInfo.project.name === 'chromium-desktop') {
    await page.setViewportSize({ width: 320, height: 568 })
    expect(await popup.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.setViewportSize({ width: 1440, height: 900 })
  }
  const secret = popup.locator('code')
  await popup.screenshot({
    path: testInfo.outputPath('token-client-setup.png'),
    scale: 'css',
    mask: [secret],
    maskColor: '#444',
  })

  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const token = await secret.innerText()
    await mcp.click()
    await expect(guides.getByRole('button', { name: 'MCP setup copied' })).toBeVisible()
    const mcpInstructions = await page.evaluate(() => navigator.clipboard.readText())
    expect(mcpInstructions).toContain(new URL('/mcp/', page.url()).href)
    expect(mcpInstructions).toContain('Authorization: Bearer <token>')
    expect(mcpInstructions).not.toContain(token)
    await rest.click()
    await expect(guides.getByRole('button', { name: 'REST setup copied' })).toBeVisible()
    const restInstructions = await page.evaluate(() => navigator.clipboard.readText())
    expect(restInstructions).toContain('/api/v1/openapi.json')
    expect(restInstructions).not.toContain(token)
  }
  if (testInfo.project.use.hasTouch) {
    const access = await popup.getByRole('button', { name: /REST setup/ }).boundingBox()
    expect(access?.height).toBeGreaterThanOrEqual(44)
  }
  await popup.getByRole('button', { name: 'I saved it' }).click()
  await expect(popup).toBeHidden()
  await expect(issue).toBeFocused()
})

test('MCP setup checks a scoped token and links to filtered activity', async ({
  browserName,
  context,
  page,
  request,
}, testInfo) => {
  const response = await request.post('/api/v1/agent-tokens', {
    data: {
      actor_id: `agent:mcp-setup-${randomUUID().slice(0, 8)}`,
      display_name: 'MCP setup test',
      label: 'MCP reader',
      scopes: [{ capability: 'read', path_prefix: 'research' }],
    },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  const issued = z.object({ token_id: z.string(), token: z.string() }).parse(await response.json())
  await page.goto('/settings?category=agents')
  const setup = page.getByRole('region', { name: 'MCP setup' })
  const serverUrl = new URL('/mcp/', page.url())
  await expect(setup.getByLabel('MCP server URL')).toHaveValue(serverUrl.href)
  await setup.getByText('Client instructions', { exact: true }).click()
  await expect(setup.getByText(/Authorization: Bearer <token>/)).toBeVisible()
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await setup.getByRole('button', { name: 'Copy MCP setup' }).click()
    await expect(setup.getByRole('status')).toHaveText('MCP setup copied')
    const instructions = await page.evaluate(() => navigator.clipboard.readText())
    expect(instructions).toContain(serverUrl.href)
    expect(instructions).toContain('Authorization: Bearer <token>')
    expect(instructions).not.toContain(issued.token)
  }
  const token = setup.getByLabel('Agent token for connection check')
  const check = setup.getByRole('button', { name: 'Check connection' })
  await token.fill('invalid')
  await check.click()
  await expect(setup.getByText('Token rejected', { exact: true })).toBeVisible()
  await token.fill(issued.token)
  await check.click()
  await expect(setup.getByText('MCP connection works', { exact: true })).toBeVisible()
  await expect(token).toHaveValue('')
  if (testInfo.project.use.hasTouch) {
    expect((await check.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  }
  if (testInfo.project.name === 'chromium-desktop') {
    await page.setViewportSize({ width: 320, height: 568 })
    expect(await page.locator('html').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    )
    await page.setViewportSize({ width: 1440, height: 900 })
  }
  await setup.getByText('Client instructions', { exact: true }).click()
  await setup.screenshot({ path: testInfo.outputPath('mcp-setup.png'), scale: 'css' })

  const client = new Client({ name: 'Sangam browser test', version: '1.0.0' })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(serverUrl, {
        authProvider: { token: async () => issued.token },
      }),
    )
    const reply = await client.callTool({
      name: 'execute',
      arguments: {
        execution_key: randomUUID(),
        code: 'await documents_create(title="Denied draft", content="private", path="research/denied.md", operation_key="denied")',
      },
    })
    expect(reply.isError).toBe(true)
  } finally {
    await client.close()
  }
  const rest = await request.get('/api/v1/documents', {
    headers: { Authorization: `Bearer ${issued.token}` },
  })
  expect(rest.ok()).toBeTruthy()
  await setup.getByRole('link', { name: 'View MCP activity' }).click()
  await expect(page).toHaveURL(/[?&]via=mcp(?:&|$)/)
  await expect(page.getByLabel('Made through')).toHaveValue('mcp')
  await page.getByRole('combobox', { name: 'Token', exact: true }).selectOption(issued.token_id)
  await expect(page.locator('.activity-operation')).toHaveCount(1)
  await page.getByLabel('Made through').selectOption('')
  await expect(page.locator('.activity-operation')).toHaveCount(2)
})
