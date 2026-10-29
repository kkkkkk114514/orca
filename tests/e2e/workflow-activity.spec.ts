import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test } from './helpers/orca-app'

test.use({ seedTestRepo: false })

test('shows live workflow records and quiet status without terminating the node', async ({
  sharedPage: page,
  electronApp
}, testInfo) => {
  test.setTimeout(240_000)
  const profile = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const workspace = join(profile, 'workflow-activity-folder')
  await mkdir(workspace)
  const script = join(workspace, 'cli.mjs')
  const finish = join(workspace, 'finish')
  const more = join(workspace, 'more')
  await writeFile(
    script,
    `
import { existsSync } from 'node:fs';
console.log(JSON.stringify({ type: 'session', sessionId: 'session-activity-test' }));
console.log(JSON.stringify({ type: 'status', phase: 'turn_start' }));
for (let i = 0; i < 65; i++) console.log(JSON.stringify({ type: 'text', text: 'Public record ' + i }));
console.log(JSON.stringify({ type: 'tool_call', tool: 'shell', input: { command: 'npm test' } }));
console.log(JSON.stringify({ type: 'tool_result', result: 'Workflow tests passed', status: 'completed' }));
console.log(JSON.stringify({ type: 'tool_call', tool: 'Write', input: { path: 'demo.ts', content: 'export const demo = 1' } }));
let sent = false;
const timer = setInterval(() => {
 if (!sent && existsSync(${JSON.stringify(more)})) {
   sent = true;
   console.log(JSON.stringify({ type: 'text', text: 'Live follow-up record' }));
 }
 if (!existsSync(${JSON.stringify(finish)})) return;
 clearInterval(timer);
 console.log(JSON.stringify({ type: 'final', text: JSON.stringify({ outcome: 'succeeded', body: 'Activity verification complete', filesModified: [] }) }));
}, 50);
`
  )
  const id = randomUUID()
  const workflowId = randomUUID()
  const started = await page.evaluate(
    async ({ workspace, script, program, id, workflowId }) => {
      await window.api.settings.set({
        agentCmdOverrides: { dsh: program },
        agentDefaultArgs: { dsh: JSON.stringify(script) },
        disabledTuiAgents: []
      })
      const group = await window.api.projectGroups.create({
        name: 'Workflow activity',
        parentPath: workspace
      })
      const folder = await window.api.folderWorkspaces.create({
        projectGroupId: group.id,
        name: 'Workflow activity',
        folderPath: workspace
      })
      const response = await window.api.runtime.call({
        method: 'workflow.start',
        params: {
          id,
          workflowId,
          worktree: `id:folder:${folder.id}`,
          input: 'Verify live progress',
          definition: {
            version: 1,
            name: 'Activity verification',
            entry: 'develop',
            maxSteps: 2,
            nodes: [
              {
                id: 'develop',
                type: 'agent',
                agent: 'dsh',
                prompt: 'Work',
                onSuccess: 'done',
                onFailure: 'failed'
              },
              { id: 'done', type: 'end', outcome: 'succeeded' },
              { id: 'failed', type: 'end', outcome: 'failed' }
            ]
          }
        }
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      localStorage.setItem(
        'orca.workflow-run.v1',
        JSON.stringify({
          id,
          workflowId,
          worktreeId: `folder:${folder.id}`,
          target: { kind: 'local' },
          workspaceLabel: 'Workflow activity'
        })
      )
      localStorage.setItem(
        'orca.workflow-canvas.v1',
        JSON.stringify({
          format: 'orca-workflow-canvas',
          version: 1,
          workflowId,
          name: 'Activity verification',
          entry: 'develop',
          maxSteps: 2,
          nodes: [
            {
              id: 'develop',
              type: 'workflow',
              position: { x: 0, y: 0 },
              data: {
                label: 'develop',
                kind: 'agent',
                agent: 'dsh',
                prompt: 'Work',
                outcome: 'succeeded'
              }
            },
            {
              id: 'done',
              type: 'workflow',
              position: { x: 360, y: 0 },
              data: { label: 'done', kind: 'end', agent: 'codex', prompt: '', outcome: 'succeeded' }
            },
            {
              id: 'failed',
              type: 'workflow',
              position: { x: 360, y: 280 },
              data: { label: 'failed', kind: 'end', agent: 'codex', prompt: '', outcome: 'failed' }
            }
          ],
          edges: [
            {
              id: 'develop:succeeded',
              source: 'develop',
              target: 'done',
              sourceHandle: 'succeeded',
              targetHandle: 'input'
            },
            {
              id: 'develop:failed',
              source: 'develop',
              target: 'failed',
              sourceHandle: 'failed',
              targetHandle: 'input'
            }
          ]
        })
      )
      window.__store?.getState().setActiveView('automations')
      return response.ok
    },
    { workspace, script, program: process.execPath, id, workflowId }
  )
  expect(started).toBe(true)
  await page.getByRole('tab', { name: /Workflows|工作流/ }).click()
  await page.getByText(/Step history and reports|步骤历史与报告/).click()
  const node = page.locator('.workflow-node[data-run-state="running"]')
  await expect(node).toHaveCount(1)
  const log = page.getByRole('list', { name: /Node activity log|节点活动记录/ })
  await expect(log).toContainText('npm test')
  await node.getByRole('button', { name: /Open node conversation|打开节点会话/ }).click()
  const sidebarHistory = page.locator('[data-workspace-session-history]')
  const dshGroup = sidebarHistory.locator('[data-session-agent-group="dsh"]')
  await expect(dshGroup.getByRole('button').first()).toHaveAttribute('aria-expanded', 'false')
  await dshGroup.getByRole('button').first().click()
  const session = page.getByTestId('workflow-session-view')
  await expect(session).toBeVisible()
  const transcript = session.locator('[data-session-native-transcript]')
  await expect(transcript.locator('[data-native-chat-tool-run-members]')).toHaveCount(0)
  await expect(transcript).not.toContainText('Workflow tests passed')
  await transcript.locator('button[aria-expanded="false"]').last().click()
  const members = transcript.locator('[data-native-chat-tool-run-members]')
  await expect(members).toBeVisible()
  const closedDetails = members.locator('button[aria-expanded="false"]')
  while (await closedDetails.count()) {
    await closedDetails.first().click()
  }
  await expect(transcript).toContainText('Workflow tests passed')
  await expect(transcript).toContainText('export const demo = 1')
  await expect(transcript.getByText('Workflow tests passed', { exact: true })).toBeVisible()
  await expect(
    transcript
      .locator('[data-native-chat-code-content]')
      .filter({ hasText: 'export const demo = 1' })
      .first()
  ).toBeVisible()
  await members.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('workflow-native-tools.png') })
  await expect(session).toContainText('npm test')
  await session.getByRole('button', { name: /Load earlier records|加载更早记录/ }).click()
  await expect(session).toContainText('CLI started; waiting for output.')
  await expect(session).toContainText(/Read only|只读/)
  await expect(session.getByRole('textbox')).toHaveCount(0)
  await expect(sidebarHistory.locator('[data-workflow-session-row]')).toHaveCount(1)
  await sidebarHistory.locator('[data-workflow-session-row]').click()
  await writeFile(more, '')
  await expect(session).toContainText('Live follow-up record')
  await expect(session).toContainText('CLI started; waiting for output.')
  await page.screenshot({ path: testInfo.outputPath('workflow-session.png') })
  const tab = await page.evaluate(() => {
    const state = window.__store?.getState()
    const tab = Object.values(state?.unifiedTabsByWorktree ?? {})
      .flat()
      .find((tab) => tab.entityId.startsWith('workflow-view:'))
    if (!tab) {
      throw new Error('No workflow record tab')
    }
    state?.setActiveView('automations')
    return { id: tab.id, workspaceId: tab.worktreeId }
  })
  await node.getByRole('button', { name: /Open node conversation|打开节点会话/ }).click()
  await expect(session).toBeVisible()
  await expect(sidebarHistory.locator('[data-workflow-session-row]')).toHaveCount(1)
  await page.evaluate(({ id }) => window.__store?.getState().closeUnifiedTab(id), tab)
  await expect(sidebarHistory.locator('[data-workflow-session-row]')).toHaveCount(1)
  await expect(
    sidebarHistory.getByRole('button', { name: /Recent|最近/, exact: true })
  ).toHaveCount(0)
  await expect(sidebarHistory.getByRole('textbox')).toHaveCount(0)
  await expect(sidebarHistory).not.toContainText(/Skipped|MiB|Archiving|归档保留/)
  const runningRow = sidebarHistory.locator('[data-session-history-row]').first()
  const archiveRunning = runningRow.getByRole('button', {
    name: /Archive conversation|归档会话记录/,
    exact: true
  })
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
  })
  await page.mouse.move(0, 0)
  await expect(runningRow.locator('[data-session-row-actions]')).toHaveCSS('opacity', '0')
  await runningRow.hover()
  await expect(runningRow.locator('[data-session-row-actions]')).toHaveCSS('opacity', '1')
  await archiveRunning.click()
  await expect(sidebarHistory.locator('[data-workflow-session-row]')).toHaveCount(0)
  await page.getByRole('button', { name: /Conversations|会话记录/, exact: true }).click()
  const workspaceHistory = page.locator('[data-workspace-session-history-panel]')
  await expect(
    workspaceHistory.getByRole('heading', { name: /Conversations|会话记录/, exact: true })
  ).toBeVisible()
  await workspaceHistory.getByRole('button', { name: /Archived|已归档/, exact: true }).click()
  const archivedRunning = workspaceHistory.locator('[data-session-history-row]').first()
  await expect(archivedRunning).toBeVisible()
  await archivedRunning.hover()
  await archivedRunning
    .getByRole('button', { name: /Restore conversation|恢复会话记录/, exact: true })
    .click()
  await workspaceHistory.getByRole('button', { name: /Recent|最近/, exact: true }).click()
  await expect(
    workspaceHistory.getByRole('button', { name: /Recent|最近/, exact: true })
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(sidebarHistory.locator('[data-workflow-session-row]')).toHaveCount(1)
  await page.screenshot({ path: testInfo.outputPath('workspace-history-workflow.png') })
  const afterClose = await page.evaluate(async (id) => {
    const result = await window.api.runtime.call({ method: 'workflow.show', params: { id } })
    window.__store?.getState().setActiveView('automations')
    return result.ok ? result.result : null
  }, id)
  expect(afterClose).toMatchObject({ phase: 'running' })
  await expect(node).toHaveCount(1)
  await page.getByText(/Step history and reports|步骤历史与报告/).click()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(
    await node
      .locator('svg.motion-safe\\:animate-spin')
      .evaluate((element) => getComputedStyle(element).animationName)
  ).toBe('none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  expect(
    await node
      .locator('svg.motion-safe\\:animate-spin')
      .evaluate((element) => getComputedStyle(element).animationName)
  ).not.toBe('none')
  await page.screenshot({ path: testInfo.outputPath('workflow-running.png') })

  const dispatchId = await page.evaluate(async (id) => {
    const response = await window.api.runtime.call({ method: 'workflow.show', params: { id } })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return response.result
  }, id)
  const { workflowRunSnapshotSchema } = await import('../../src/shared/workflow-run-contract')
  const dispatch = workflowRunSnapshotSchema.parse(dispatchId).execution?.steps[0]?.dispatchId
  if (!dispatch) {
    throw new Error('Missing active dispatch')
  }
  const activityPath = join(profile, 'workflow-headless', `${dispatch}.json.activity.json`)
  const activity = JSON.parse(await readFile(activityPath, 'utf8'))
  await writeFile(activityPath, JSON.stringify({ ...activity, lastOutputAt: Date.now() - 180_000 }))
  await expect(page.locator('.workflow-node[data-run-state="quiet"]')).toHaveCount(1)
  await expect(page.getByText(/No CLI output for two minutes|CLI 已两分钟/)).toBeVisible()
  await expect(page.locator('.workflow-node svg.motion-safe\\:animate-spin')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('workflow-quiet.png') })
  await writeFile(finish, '')
  await page.getByRole('button', { name: /View this run’s canvas|查看本轮画布/ }).click()
  await expect(page.locator('.workflow-node[data-run-state="succeeded"]')).toHaveCount(2)
  await expect(log).toContainText(/completion report validated/)
  await page.getByRole('button', { name: /Manage run records|管理本轮记录/ }).click()
  const cleanup = page.getByRole('dialog')
  await cleanup.getByRole('button', { name: /Preview cleanup|预览清理范围/ }).click()
  await expect(cleanup.getByRole('status')).toContainText(/files|个文件/)
  const clear = cleanup.getByRole('button', { name: /Permanently clear|永久清理/ })
  await expect(clear).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('workflow-cleanup-preview.png') })
  await clear.click()
  await expect(cleanup.getByRole('status')).toContainText(/deleted|已删除/)
  await cleanup.getByRole('button', { name: /Cancel|取消/, exact: true }).click()
  await page
    .locator('.workflow-node')
    .filter({ hasText: 'develop' })
    .getByRole('button', { name: /Open node conversation|打开节点会话/ })
    .click()
  await expect(page.getByTestId('workflow-session-view')).toContainText(
    /Public logs were cleared|公开日志已清理/
  )
  await expect(page.getByTestId('workflow-session-view')).not.toContainText('Public record 64')
  await page.evaluate(() => window.__store?.getState().setActiveView('automations'))
  await page.getByRole('button', { name: /New run|新一轮/, exact: true }).click()
  await page.getByRole('button', { name: /Run workflow|运行工作流/, exact: true }).click()
  const startDialog = page.getByRole('dialog')
  await expect(startDialog.getByRole('switch')).toHaveCount(0)
  await startDialog
    .getByRole('textbox', { name: /Task|任务/, exact: true })
    .fill('Verify the next task')
  await page.screenshot({ path: testInfo.outputPath('workflow-node-session-choice.png') })
  await startDialog.getByRole('button', { name: /Start|开始/, exact: true }).click()
  await page.getByRole('button', { name: /View this run’s canvas|查看本轮画布/ }).click()
  await expect(page.locator('.workflow-node[data-run-state="succeeded"]')).toHaveCount(2)
  await page.getByText(/Step history and reports|步骤历史与报告/).click()
  await expect(page.getByText('Resumed node session', { exact: true })).toBeVisible()
  const isolatedHome = await electronApp.evaluate(({ app }) => app.getPath('home'))
  const nativeId = randomUUID()
  const nativeDirectory = join(isolatedHome, '.codex', 'sessions', '2026', '10', '26')
  await mkdir(nativeDirectory, { recursive: true })
  await writeFile(
    join(nativeDirectory, `rollout-2026-10-26T10-00-00-${nativeId}.jsonl`),
    `${[
      {
        timestamp: '2026-10-26T10:00:00Z',
        type: 'session_meta',
        payload: { id: nativeId, cwd: workspace }
      },
      {
        timestamp: '2026-10-26T10:00:01Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Ordinary Codex history acceptance' }
      },
      {
        timestamp: '2026-10-26T10:00:02Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Read-only answer from original history' }
      },
      {
        timestamp: '2026-10-26T10:00:03Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell_command',
          call_id: 'native-cmd',
          arguments: JSON.stringify({ command: 'pnpm test' })
        }
      },
      {
        timestamp: '2026-10-26T10:00:04Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'native-cmd',
          output: 'Native tests passed'
        }
      }
    ]
      .map((event) => JSON.stringify(event))
      .join('\n')}\n`
  )
  await page.evaluate(() => window.__store?.getState().setActiveView('terminal'))
  if (!(await workspaceHistory.isVisible())) {
    await page.getByRole('button', { name: /Conversations|会话记录/, exact: true }).click()
  }
  await workspaceHistory.getByRole('button', { name: /Refresh conversations|刷新会话记录/ }).click()
  const ordinary = workspaceHistory
    .locator('[data-session-history-row]')
    .filter({ hasText: 'Ordinary Codex history acceptance' })
  await expect(ordinary).toHaveCount(1)
  await ordinary.getByRole('button').first().click()
  const nativeView = page.getByTestId('workspace-session-history-view')
  await expect(nativeView).toContainText('Read-only answer from original history')
  await expect(nativeView).not.toContainText('Native tests passed')
  await nativeView
    .locator('[data-session-native-transcript] button[aria-expanded="false"]')
    .first()
    .click()
  await nativeView
    .locator('[data-native-chat-tool-run-members] button[aria-expanded="false"]')
    .first()
    .click()
  await expect(nativeView).toContainText('Native tests passed')
  await expect(nativeView.getByText('Native tests passed', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('workspace-history-native-chat.png') })
  await expect(nativeView.getByRole('textbox')).toHaveCount(0)
  const recordWidth = await nativeView.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    parent: element.parentElement?.getBoundingClientRect().width ?? 0
  }))
  expect(recordWidth.width).toBeGreaterThanOrEqual(recordWidth.parent - 2)
  const historyTabCount = await page.evaluate(
    () =>
      Object.values(window.__store?.getState().unifiedTabsByWorktree ?? {})
        .flat()
        .filter((tab) => tab.entityId.startsWith('workspace-history:')).length
  )
  expect(historyTabCount).toBe(1)
  await ordinary.hover()
  await ordinary
    .getByRole('button', { name: /Archive conversation|归档会话记录/, exact: true })
    .click()
  await expect(ordinary).toHaveCount(0)
  await workspaceHistory.getByRole('button', { name: /Archived|已归档/, exact: true }).click()
  const archivedOrdinary = workspaceHistory
    .locator('[data-session-history-row]')
    .filter({ hasText: 'Ordinary Codex history acceptance' })
  await expect(archivedOrdinary).toHaveCount(1)
  await archivedOrdinary.getByRole('button').first().click()
  await expect(page.getByTestId('workspace-session-history-view')).toContainText(
    'Read-only answer from original history'
  )
  await page.screenshot({ path: testInfo.outputPath('workspace-history-archived.png') })
  await archivedOrdinary.hover()
  await archivedOrdinary
    .getByRole('button', { name: /Restore conversation|恢复会话记录/, exact: true })
    .click()
  await workspaceHistory.getByRole('button', { name: /Recent|最近/, exact: true }).click()
  await expect(
    workspaceHistory
      .locator('[data-session-history-row]')
      .filter({ hasText: 'Ordinary Codex history acceptance' })
  ).toHaveCount(1)
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
