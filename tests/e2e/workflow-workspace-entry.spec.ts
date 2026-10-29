import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './helpers/orca-app'
import {
  workflowScopedStorageKey,
  workflowWorkspaceScope
} from '../../src/renderer/src/components/workflow-canvas/workflow-workspace-scope'

test.use({ seedTestRepo: false })

test('opens workspace workflows from sidebar icons and restores independent drafts and runs', async ({
  sharedPage: page,
  electronApp
}, testInfo) => {
  test.setTimeout(180_000)
  const profile = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const parent = join(profile, 'workflow-entry-workspaces')
  const folders = [join(parent, 'a'), join(parent, 'b')]
  await Promise.all(folders.map((path) => mkdir(path, { recursive: true })))
  const definition = {
    version: 1,
    name: 'Shared workflow',
    entry: 'done',
    maxSteps: 1,
    nodes: [{ id: 'done', type: 'end', outcome: 'succeeded' }]
  }
  const ids = await page.evaluate(
    async ({ parent, folders, definition }) => {
      const group = await window.api.projectGroups.create({
        name: 'Workflow entries',
        parentPath: parent
      })
      const ids: string[] = []
      for (const [index, folderPath] of folders.entries()) {
        const workspace = await window.api.folderWorkspaces.create({
          projectGroupId: group.id,
          name: `Workspace ${index === 0 ? 'A' : 'B'}`,
          folderPath
        })
        ids.push(`folder:${workspace.id}`)
      }
      localStorage.setItem('orca.workflow-canvas.v1', JSON.stringify(definition))
      window.__store?.getState().setActiveView('terminal')
      return ids
    },
    { parent, folders, definition }
  )
  const icon = (id: string) => page.locator(`[data-workspace-workflow="${id}"]`)
  const name = () => page.getByRole('textbox', { name: /Workflow name|工作流名称/, exact: true })
  const binding = async (id: string) =>
    page.evaluate(
      (key) => {
        const saved = localStorage.getItem(key)
        return saved ? JSON.parse(saved) : null
      },
      workflowScopedStorageKey(
        'orca.workflow-run.v1',
        workflowWorkspaceScope({ kind: 'local' }, id)
      )
    )
  const start = async (task: string) => {
    await page.getByRole('button', { name: /Run workflow|运行工作流/, exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: /Task|任务/, exact: true }).fill(task)
    await dialog.getByRole('button', { name: /Start|启动/, exact: true }).click()
    await expect(
      page.getByRole('button', { name: /View this run’s canvas|查看本轮画布/ })
    ).toBeVisible({ timeout: 30_000 })
  }

  await expect(icon(ids[0])).toBeVisible()
  await expect(icon(ids[1])).toBeVisible()
  await icon(ids[0]).click()
  await expect(page.getByRole('heading', { name: /Workflow canvas|工作流画布/ })).toBeVisible()
  await expect(name()).toHaveValue('Shared workflow')
  await expect(page.getByRole('region', { name: /Workflow execution|工作流执行/ })).toContainText(
    'Workspace A'
  )
  expect(await binding(ids[0])).toBeNull()
  await start('Workspace A validation without any agent invocation')
  const first = await binding(ids[0])
  expect(first.worktreeId).toBe(ids[0])
  await expect(
    page.getByRole('button', { name: /View this run’s canvas|查看本轮画布/ })
  ).toBeVisible()

  await icon(ids[1]).click()
  await expect(name()).toHaveValue('Shared workflow')
  await expect(page.getByRole('region', { name: /Workflow execution|工作流执行/ })).toContainText(
    'Workspace B'
  )
  expect(await binding(ids[1])).toBeNull()
  await expect(
    page.getByRole('button', { name: /View this run’s canvas|查看本轮画布/ })
  ).toHaveCount(0)
  await page.locator('input[type="file"]').setInputFiles({
    name: 'workspace-b.workflow.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...definition, name: 'Imported for B' }))
  })
  await expect(name()).toHaveValue('Imported for B')
  await icon(ids[0]).click()
  await expect(name()).toHaveValue('Shared workflow')
  await expect.poll(async () => (await binding(ids[0]))?.id).toBe(first.id)
  await expect(
    page.getByRole('button', { name: /View this run’s canvas|查看本轮画布/ })
  ).toBeVisible({ timeout: 20_000 })
  await icon(ids[1]).click()
  await expect(name()).toHaveValue('Imported for B')
  await start('Workspace B validation without any agent invocation')
  const second = await binding(ids[1])
  expect(second.id).not.toBe(first.id)
  expect(second.worktreeId).toBe(ids[1])
  await page.screenshot({ path: testInfo.outputPath('workspace-workflow-entry.png') })
  await page.reload()
  await icon(ids[0]).click()
  await expect(name()).toHaveValue('Shared workflow')
  expect((await binding(ids[0])).id).toBe(first.id)
  expect((await binding(ids[1])).id).toBe(second.id)
  expect(
    await page.evaluate((ids) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('App store unavailable')
      }
      const tabs = ids.flatMap((id) => state.unifiedTabsByWorktree[id] ?? [])
      const launched = Object.keys(state.agentLaunchConfigByPaneKey).filter((key) =>
        tabs.some((tab) => key.startsWith(`${tab.id}:`))
      )
      const active = Object.values(state.agentStatusByPaneKey).filter(
        (entry) => entry.worktreeId && ids.includes(entry.worktreeId) && entry.agentType
      )
      return (
        tabs.filter((tab) => tab.contentType === 'agent-session').length +
        launched.length +
        active.length
      )
    }, ids)
  ).toBe(0)
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
