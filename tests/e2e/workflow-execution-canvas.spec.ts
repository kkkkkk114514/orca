import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test } from './helpers/orca-app'

test.use({ seedTestRepo: false })

test('keeps a saved execution selectable and navigable when its draft has changed', async ({
  sharedPage: page,
  electronApp
}, testInfo) => {
  test.setTimeout(180_000)
  const profile = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const workspace = join(profile, 'execution-canvas-workspace')
  await mkdir(workspace)
  const script = join(workspace, 'codex-probe.cjs')
  const body =
    "if(process.argv.includes('features') && process.argv.includes('list')) console.log('network_proxy experimental true'); else process.exit(1);"
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
    async ({ workspace, command, id, workflowId }) => {
      await window.api.settings.set({
        agentCmdOverrides: { codex: command },
        disabledTuiAgents: []
      })
      const group = await window.api.projectGroups.create({
        name: 'Execution canvas',
        parentPath: workspace
      })
      const folder = await window.api.folderWorkspaces.create({
        projectGroupId: group.id,
        name: 'Execution canvas',
        folderPath: workspace
      })
      const result = await window.api.runtime.call({
        method: 'workflow.start',
        params: {
          id,
          workflowId,
          worktree: `id:folder:${folder.id}`,
          input: 'Verify canvas without launching an agent',
          definition: {
            version: 1,
            name: 'Saved execution',
            entry: 'done',
            maxSteps: 1,
            nodes: [{ id: 'done', type: 'end', outcome: 'succeeded' }]
          }
        }
      })
      if (!result.ok) {
        throw new Error(result.error.message)
      }
      localStorage.setItem(
        'orca.workflow-run.v1',
        JSON.stringify({
          id,
          workflowId,
          target: { kind: 'local' },
          worktreeId: `folder:${folder.id}`,
          workspaceLabel: 'Execution canvas'
        })
      )
      localStorage.setItem(
        'orca.workflow-canvas.v1',
        JSON.stringify({
          format: 'orca-workflow-canvas',
          version: 2,
          workflowId,
          name: 'Edited permissions draft',
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
                outcome: 'succeeded',
                launch: { security: { access: 'read-only' } }
              }
            },
            {
              id: 'done',
              type: 'workflow',
              position: { x: 360, y: 0 },
              data: { label: 'Done', kind: 'end', agent: 'codex', prompt: '', outcome: 'succeeded' }
            }
          ],
          edges: ['succeeded', 'failed'].map((outcome) => ({
            id: outcome,
            source: 'develop',
            target: 'done',
            sourceHandle: outcome,
            targetHandle: 'input'
          }))
        })
      )
      window.__store?.getState().setActiveWorktree(`folder:${folder.id}`)
      window.__store?.getState().setActiveView('automations')
    },
    { workspace, command, id: randomUUID(), workflowId: randomUUID() }
  )
  await page.getByRole('tab', { name: /Workflows|工作流/ }).click()
  const viewRun = page.getByRole('button', { name: /View this run’s canvas|查看本轮画布/ })
  await expect(viewRun).toBeVisible()
  await expect(page.getByRole('button', { name: /Add node|添加节点/, exact: true })).toBeEnabled()
  await page.locator('.workflow-node').filter({ hasText: 'Develop' }).click()
  const name = page.getByRole('textbox', { name: /Node name|节点名称/, exact: true })
  await expect(name).toBeEnabled()
  const conversation = page.getByRole('radio', { name: /New conversation|新开会话/, exact: true })
  await expect(
    page.getByRole('radio', { name: /Automatically choose latest|自动选择最新/, exact: true })
  ).toBeChecked()
  await conversation.click()
  const access = page.getByRole('combobox', { name: /Filesystem access|访问范围/ })
  await expect(access).toBeEnabled()
  await access.click()
  await page.getByRole('option', { name: /Write in workspace|可写当前工作区/, exact: true }).click()
  await expect(access).toContainText(/Write in workspace|可写当前工作区/)
  await page.waitForTimeout(2500)
  await expect(name).toBeEnabled()
  await expect(access).toBeEnabled()
  await viewRun.click()
  const node = page.locator('.react-flow__node').filter({ hasText: 'done' })
  await expect(node).toHaveCount(1)
  await node.click()
  await expect(node).toHaveClass(/selected/)
  await expect(name).toBeDisabled()
  await expect(page.getByRole('button', { name: /Add node|添加节点/, exact: true })).toBeDisabled()
  await expect(page.locator('.react-flow__minimap-node')).toHaveCount(1)
  // A snapshot poll must preserve selection and the measured node dimensions.
  await page.waitForTimeout(2500)
  await expect(node).toHaveClass(/selected/)
  const viewport = page.locator('.react-flow__viewport')
  const beforeZoom = await viewport.getAttribute('style')
  await page.getByRole('button', { name: /Zoom out|缩小/, exact: true }).click()
  await expect(viewport).not.toHaveAttribute('style', beforeZoom ?? '')
  const afterZoom = await viewport.getAttribute('style')
  const bounds = await page.getByTestId('workflow-graph').boundingBox()
  if (!bounds) {
    throw new Error('Workflow graph is missing')
  }
  await page.mouse.move(bounds.x + 50, bounds.y + bounds.height - 100)
  await page.mouse.down()
  await page.mouse.move(bounds.x + 130, bounds.y + bounds.height - 140, { steps: 8 })
  await page.mouse.up()
  await expect(viewport).not.toHaveAttribute('style', afterZoom ?? '')
  const afterPan = await viewport.getAttribute('style')
  await page.waitForTimeout(2500)
  await expect(viewport).toHaveAttribute('style', afterPan ?? '')
  await page.screenshot({ path: testInfo.outputPath('execution-canvas.png') })
  await page.getByRole('button', { name: /Edit next draft|编辑下一轮草稿/ }).click()
  await page.locator('.workflow-node').filter({ hasText: 'Develop' }).click()
  await expect(name).toBeEnabled()
  await expect(access).toContainText(/Write in workspace|可写当前工作区/)
  await page.reload()
  await page.getByRole('tab', { name: /Workflows|工作流/ }).click()
  await page.locator('.workflow-node').filter({ hasText: 'Develop' }).click()
  await expect(name).toBeEnabled()
  await expect(access).toContainText(/Write in workspace|可写当前工作区/)
  await page.screenshot({ path: testInfo.outputPath('editable-permissions-draft.png') })
  await expect(conversation).toBeChecked()
  await page.getByRole('button', { name: /New run|新一轮|新运行/, exact: true }).click()
  await expect(page.locator('.workflow-node').filter({ hasText: 'Develop' })).toHaveCount(1)
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('orca.workflow-canvas.v1') ?? '{}'))
  ).toMatchObject({
    name: 'Edited permissions draft',
    nodes: [
      {
        data: { launch: { security: { access: 'workspace-write' } }, conversation: { mode: 'new' } }
      },
      { id: 'done' }
    ]
  })
  await page.getByRole('button', { name: /Run workflow|运行工作流/, exact: true }).click()
  await page
    .getByRole('textbox', { name: /Task|任务/, exact: true })
    .fill('Verify per-node conversation selection without running an agent')
  const continuation = page.getByRole('switch', {
    name: /Continue previous node conversations|继续上一轮节点会话/
  })
  await expect(continuation).toHaveCount(0)
  await page.getByRole('dialog').press('Escape')
  expect(await page.evaluate(() => localStorage.getItem('orca.workflow-run.v1'))).toBeNull()
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
