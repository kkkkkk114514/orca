import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test } from './helpers/orca-app'

test.use({ seedTestRepo: false })

test('configures independent node permissions and retains them after reload without starting an agent', async ({
  sharedPage: page,
  electronApp
}, testInfo) => {
  const profile = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const workspace = join(profile, 'security-workspace')
  await mkdir(workspace)
  const ledger = join(workspace, 'probes.jsonl')
  const script = join(workspace, 'codex-probe.cjs')
  const body = `const {appendFileSync}=require('node:fs'); const args=process.argv.slice(2); appendFileSync(${JSON.stringify(ledger)},JSON.stringify(args)+'\\n'); if(args.includes('features') && args.includes('list')) console.log('network_proxy experimental true'); else process.exit(1);`
  const command = join(workspace, process.platform === 'win32' ? 'codex.cmd' : 'codex')
  await writeFile(script, body)
  await writeFile(
    command,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "%~dp0\\codex-probe.cjs" %*\r\n`
      : `#!/usr/bin/env node\n${body}\n`
  )
  if (process.platform !== 'win32') {
    await chmod(command, 0o755)
  }
  await page.evaluate(
    async ({ workspace, command, workflowId }) => {
      await window.api.settings.set({
        agentCmdOverrides: { codex: command },
        disabledTuiAgents: []
      })
      const group = await window.api.projectGroups.create({
        name: 'Node permissions',
        parentPath: workspace
      })
      const folder = await window.api.folderWorkspaces.create({
        projectGroupId: group.id,
        name: 'Node permissions',
        folderPath: workspace
      })
      window.__store?.getState().setActiveWorktree(`folder:${folder.id}`)
      localStorage.setItem(
        'orca.workflow-canvas.v1',
        JSON.stringify({
          format: 'orca-workflow-canvas',
          version: 1,
          workflowId,
          name: 'Permissions',
          entry: 'develop',
          maxSteps: 2,
          nodes: [
            {
              id: 'develop',
              type: 'workflow',
              position: { x: 0, y: 0 },
              data: {
                label: 'Develop',
                kind: 'agent',
                agent: 'codex',
                prompt: 'Work',
                outcome: 'succeeded'
              }
            },
            {
              id: 'done',
              type: 'workflow',
              position: { x: 360, y: 0 },
              data: { label: 'Done', kind: 'end', agent: 'codex', prompt: '', outcome: 'succeeded' }
            }
          ],
          edges: [
            {
              id: 'success',
              source: 'develop',
              target: 'done',
              sourceHandle: 'succeeded',
              targetHandle: 'input'
            },
            {
              id: 'failure',
              source: 'develop',
              target: 'done',
              sourceHandle: 'failed',
              targetHandle: 'input'
            }
          ]
        })
      )
      window.__store?.getState().setActiveView('automations')
    },
    { workspace, command, workflowId: randomUUID() }
  )
  await page.getByRole('tab', { name: /Workflows|工作流/ }).click()
  await page.locator('.workflow-node').filter({ hasText: 'Develop' }).click()
  const access = page.getByRole('combobox', { name: /Filesystem access|访问范围/ })
  await expect(access).toBeEnabled()
  await access.click()
  await page.getByRole('option', { name: /Write in workspace|可写当前工作区/, exact: true }).click()
  const directories = page.getByRole('textbox', {
    name: /Additional writable directories|额外可写目录/
  })
  await directories.fill(workspace)
  await directories.blur()
  await page.getByRole('combobox', { name: /Approval policy|审批策略/ }).click()
  await page.getByRole('option', { name: /Never ask|不询问/ }).click()
  const network = page.getByRole('combobox', { name: /Command network access|命令网络访问/ })
  await network.click()
  await page.getByRole('option', { name: /Allow listed hosts only|仅允许指定域名/ }).click()
  const hosts = page.getByRole('textbox', { name: /Allowed hostnames|允许的域名/ })
  await hosts.fill('registry.npmjs.org\n*.example.com')
  await hosts.blur()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('orca.workflow-canvas.v1') ?? '{}').nodes?.[0]?.data
            ?.launch?.security
      )
    )
    .toEqual({
      access: 'workspace-write',
      approval: 'never',
      network: 'restricted',
      writableDirectories: [workspace],
      allowedHosts: ['registry.npmjs.org', '*.example.com']
    })
  const panelWidth = await page
    .getByRole('complementary', { name: /Properties|属性/, exact: true })
    .evaluate((element) => ({ content: element.scrollWidth, available: element.clientWidth }))
  expect(panelWidth.content).toBeLessThanOrEqual(panelWidth.available + 1)
  await page.screenshot({ path: testInfo.outputPath('workflow-node-permissions.png') })
  await page.reload()
  await page.getByRole('tab', { name: /Workflows|工作流/ }).click()
  await page.locator('.workflow-node').filter({ hasText: 'Develop' }).click()
  await expect(access).toContainText(/Write in workspace|可写当前工作区/)
  await expect(hosts).toHaveValue('registry.npmjs.org\n*.example.com')
  await network.click()
  await page.getByRole('option', { name: /Deny|禁止/, exact: true }).click()
  await expect(hosts).toHaveCount(0)
  await access.click()
  await page.getByRole('option', { name: /Read only|只读/, exact: true }).click()
  await expect(directories).toHaveCount(0)
  await expect(network).toBeDisabled()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('orca.workflow-canvas.v1') ?? '{}').nodes?.[0]?.data
            ?.launch?.security
      )
    )
    .toEqual({ access: 'read-only', approval: 'never' })
  expect(
    (await readFile(ledger, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .every((args) => args.includes('features') && args.includes('list'))
  ).toBe(true)
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
