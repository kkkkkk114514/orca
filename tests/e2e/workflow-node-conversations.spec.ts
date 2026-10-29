import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test } from './helpers/orca-app'

test.use({ seedTestRepo: false })

test('selects workspace conversations independently after changing a planner agent and instructions', async ({
  sharedPage: page,
  electronApp
}, testInfo) => {
  test.setTimeout(240_000)
  const profile = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const workspace = join(profile, 'node-conversations-workspace')
  await mkdir(workspace)
  const ledger = join(workspace, 'calls.jsonl')
  const script = join(workspace, 'workflow-cli.cjs')
  await writeFile(
    script,
    `
const {appendFileSync}=require('node:fs');
const {randomUUID}=require('node:crypto');
const agent=process.argv[2], args=process.argv.slice(3);
if(args.includes('app-server')) {
 require('node:readline').createInterface({input:process.stdin}).on('line', line=>{
  const request=JSON.parse(line);
  if(request.id===undefined) return;
  const result=request.method==='model/list'
   ? {data:[{id:'fake-modern-model',model:'fake-modern-model',displayName:'Configured modern model',supportedReasoningEfforts:[]}],nextCursor:null}
   : request.method==='config/read' ? {config:{model:'fake-private-model'}} : {};
  console.log(JSON.stringify({id:request.id,result}));
 });
} else {
const prompt=args.find(arg=>arg.startsWith('Execute this workflow step'));
if(!prompt) { if(args.includes('features')) console.log('network_proxy experimental true'); else console.log('{}'); process.exit(0); }
const resumeFlag=agent==='dsh'?'--session-id':'resume';
const resumed=args.includes(resumeFlag);
const sessionId=resumed?(agent==='codex'?args.at(-2):args[args.indexOf(resumeFlag)+1]):randomUUID();
appendFileSync(${JSON.stringify(ledger)},JSON.stringify({agent,resumed,sessionId,prompt})+'\\n');
const report=JSON.stringify({outcome:'succeeded',body:'Verified isolated fake CLI; no model called.',filesModified:[]});
if(agent==='codex') {
 console.log(JSON.stringify({type:'thread.started',thread_id:sessionId}));
 console.log(JSON.stringify({type:'turn.started'}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:report}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:20,output_tokens:5}}));
} else {
 console.log(JSON.stringify({type:'session',sessionId}));
 console.log(JSON.stringify({type:'status',phase:'turn_start'}));
 console.log(JSON.stringify({type:'final',text:report}));
}
}
`
  )
  const commands: Record<string, string> = {}
  for (const agent of ['codex', 'dsh']) {
    const command = join(workspace, process.platform === 'win32' ? `${agent}.cmd` : agent)
    await writeFile(
      command,
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "%~dp0\\workflow-cli.cjs" ${agent} %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${script}" ${agent} "$@"\n`
    )
    if (process.platform !== 'win32') {
      await chmod(command, 0o755)
    }
    commands[agent] = command
  }
  await page.evaluate(
    async ({ workspace, commands, workflowId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('App store unavailable')
      }
      await store
        .getState()
        .updateSettingsOrThrow({ agentCmdOverrides: commands, disabledTuiAgents: [] })
      const group = await window.api.projectGroups.create({
        name: 'Conversation choices',
        parentPath: workspace
      })
      const folder = await window.api.folderWorkspaces.create({
        projectGroupId: group.id,
        name: 'Conversation choices',
        folderPath: workspace
      })
      window.__store?.getState().setActiveWorktree(`folder:${folder.id}`)
      localStorage.setItem(
        'orca.workflow-canvas.v1',
        JSON.stringify({
          format: 'orca-workflow-canvas',
          version: 2,
          workflowId,
          name: 'Independent conversations',
          entry: 'plan',
          maxSteps: 3,
          nodes: [
            {
              id: 'plan',
              type: 'workflow',
              position: { x: 0, y: 0 },
              data: {
                label: 'Plan',
                kind: 'agent',
                agent: 'codex',
                prompt: 'Plan this task.',
                outcome: 'succeeded'
              }
            },
            {
              id: 'test',
              type: 'workflow',
              position: { x: 360, y: 0 },
              data: {
                label: 'Test',
                kind: 'agent',
                agent: 'codex',
                prompt: 'Test the handoff.',
                conversation: { mode: 'new' },
                outcome: 'succeeded'
              }
            },
            {
              id: 'done',
              type: 'workflow',
              position: { x: 720, y: 0 },
              data: { label: 'Done', kind: 'end', agent: 'codex', prompt: '', outcome: 'succeeded' }
            }
          ],
          edges: ['plan', 'test'].flatMap((source) =>
            ['succeeded', 'failed'].map((outcome) => ({
              id: source + outcome,
              source,
              target: source === 'plan' ? 'test' : 'done',
              sourceHandle: outcome,
              targetHandle: 'input'
            }))
          )
        })
      )
      window.__store?.getState().setActiveView('automations')
    },
    { workspace, commands, workflowId: randomUUID() }
  )
  await page.getByRole('tab', { name: /Workflows|工作流/ }).click()
  const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"] .workflow-node`)
  const automatic = page.getByRole('radio', {
    name: /Automatically choose latest|自动选择最新/,
    exact: true
  })
  const chooseConversation = async (title: RegExp) => {
    const beforePreview = (await readFile(ledger, 'utf8')).trim().split('\n').length
    await page
      .getByRole('radio', { name: /Choose a past conversation|指定历史会话/, exact: true })
      .click()
    const picker = page.getByRole('dialog', {
      name: /Select a past conversation|选择历史会话/,
      exact: true
    })
    await picker
      .getByRole('textbox', { name: /Search conversations|搜索会话/, exact: true })
      .fill(title.source)
    await picker
      .getByRole('button', { name: title })
      .filter({ hasText: /Workflow node · plan|工作流节点 · plan/ })
      .click()
    await expect(
      picker.getByText('Verified isolated fake CLI; no model called.', { exact: true }).first()
    ).toBeVisible()
    const bounds = await picker.boundingBox()
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    if (!bounds) {
      throw new Error('Picker bounds unavailable')
    }
    expect(bounds.width).toBeLessThanOrEqual(1100)
    expect(bounds.height).toBeLessThanOrEqual(viewport.height * 0.85 + 1)
    expect(
      await picker.evaluate((element) => element.scrollWidth - element.clientWidth)
    ).toBeLessThanOrEqual(1)
    await page.screenshot({ path: testInfo.outputPath('conversation-picker.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(picker).toBeVisible()
    expect(
      await picker.evaluate((element) => element.scrollWidth - element.clientWidth)
    ).toBeLessThanOrEqual(1)
    const mobile = await picker.boundingBox()
    expect(mobile?.width).toBeLessThanOrEqual(390)
    expect(mobile?.height).toBeLessThanOrEqual(844 * 0.85 + 1)
    await page.screenshot({ path: testInfo.outputPath('conversation-picker-mobile.png') })
    await page.setViewportSize(viewport)
    expect((await readFile(ledger, 'utf8')).trim().split('\n')).toHaveLength(beforePreview)
    await picker
      .getByRole('button', { name: /Use this conversation|使用此会话/, exact: true })
      .click()
  }
  const nextRun = async () => {
    await page.getByRole('button', { name: /New run|新运行/, exact: true }).click()
  }
  const start = async (task: string) => {
    await page.getByRole('button', { name: /Run workflow|运行工作流/, exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('switch')).toHaveCount(0)
    await dialog.getByRole('textbox', { name: /Task|任务/, exact: true }).fill(task)
    await dialog.getByRole('button', { name: /Start|启动/, exact: true }).click()
    await expect(
      page.getByRole('button', { name: /View this run’s canvas|查看本轮画布/ })
    ).toBeVisible({ timeout: 40_000 })
    return (await readFile(ledger, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  }
  await node('plan').click()
  await expect(automatic).toBeChecked()
  const modelPicker = page.getByRole('combobox', { name: /CLI models|CLI 模型/, exact: true })
  await expect(modelPicker).toBeVisible({ timeout: 20_000 })
  await modelPicker.click()
  await expect(page.getByRole('option', { name: 'fake-private-model', exact: true })).toBeVisible()
  await expect(
    page.getByRole('option', { name: 'Configured modern model', exact: true })
  ).toBeVisible()
  await expect(page.getByRole('option', { name: /GPT-5\.6/ })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('workflow-cli-models.png') })
  await page.getByRole('option', { name: 'Configured modern model', exact: true }).click()
  await expect(page.getByLabel(/^(Model|模型)$/)).toHaveValue('fake-modern-model')
  const first = await start(
    `First session task · ${'Add level selection, enemies and test the new game mechanics. '.repeat(20)}`
  )
  expect(first).toHaveLength(2)
  expect(first.every((item) => !item.resumed)).toBe(true)
  expect(first[0].sessionId).not.toBe(first[1].sessionId)
  await nextRun()
  await node('plan').click()
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('App store unavailable')
    }
    await store.getState().updateSettingsOrThrow({ disabledTuiAgents: ['dsh'] })
  })
  await page.getByRole('combobox', { name: /Agent|智能体/, exact: true }).click()
  const agentPicker = page
    .locator('[data-slot="popover-content"]')
    .filter({ has: page.getByPlaceholder(/Search agents|搜索智能体/) })
  await expect(agentPicker.getByRole('option', { name: /Codex/ })).toContainText(commands.codex)
  await page.getByPlaceholder(/Search agents|搜索智能体/).fill('DeepSeek')
  await expect(agentPicker.getByRole('option', { name: /DeepSeek Harness/ })).toHaveCount(0)
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('App store unavailable')
    }
    await store.getState().updateSettingsOrThrow({ disabledTuiAgents: [] })
  })
  await page.getByRole('button', { name: /Refresh agents|刷新智能体/, exact: true }).click()
  await expect(
    page.getByRole('button', { name: /Refresh agents|刷新智能体/, exact: true })
  ).toBeEnabled({ timeout: 40_000 })
  await expect(agentPicker.getByRole('option', { name: /DeepSeek Harness/ })).toContainText(
    commands.dsh,
    { timeout: 30_000 }
  )
  await page.screenshot({ path: testInfo.outputPath('workflow-configured-agents.png') })
  await agentPicker.getByRole('option', { name: /DeepSeek Harness/ }).click()
  await expect(automatic).toBeChecked()
  const second = await start('Second session task')
  expect(second).toHaveLength(4)
  expect(second[2].agent).toBe('dsh')
  expect(second[2].resumed).toBe(false)
  await nextRun()
  await node('plan').click()
  await page.getByRole('button', { name: /Refresh conversations|刷新会话/ }).click()
  await chooseConversation(/Second session task/)
  await page
    .getByRole('textbox', { name: /Instructions|指令|提示词/, exact: true })
    .fill('Revised planning instructions.')
  await node('test').click()
  await page.getByRole('button', { name: /Refresh conversations|刷新会话/ }).click()
  await chooseConversation(/First session task/)
  await page
    .getByRole('textbox', { name: /Instructions|指令|提示词/, exact: true })
    .fill('Revised testing instructions.')
  const third = await start('Third session task')
  expect(third).toHaveLength(6)
  expect(third[4]).toMatchObject({ agent: 'dsh', resumed: true, sessionId: second[2].sessionId })
  expect(third[5]).toMatchObject({ agent: 'codex', resumed: true, sessionId: first[0].sessionId })
  expect(third[4].prompt).toContain('Revised planning instructions')
  expect(third[5].prompt).toContain('Revised testing instructions')
  await page.reload()
  await page.getByRole('tab', { name: /Workflows|工作流/ }).click()
  await nextRun()
  await node('plan').click()
  await page.getByRole('radio', { name: /New conversation|新开会话/, exact: true }).click()
  const fourth = await start('Fourth session task')
  expect(fourth).toHaveLength(8)
  expect(fourth[6].resumed).toBe(false)
  expect(fourth[6].sessionId).not.toBe(third[4].sessionId)
  expect(fourth[7]).toMatchObject({ agent: 'codex', resumed: true, sessionId: first[0].sessionId })
  await node('test').click()
  const panel = page.getByRole('complementary', { name: /Properties|属性/, exact: true })
  const width = await panel.evaluate((element) => ({
    content: element.scrollWidth,
    available: element.clientWidth
  }))
  expect(width.content).toBeLessThanOrEqual(width.available + 1)
  await page.screenshot({ path: testInfo.outputPath('node-conversation-choice.png') })
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
