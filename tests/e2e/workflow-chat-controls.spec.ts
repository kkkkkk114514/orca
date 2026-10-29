import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test } from './helpers/orca-app'

test.use({ seedTestRepo: false })

test('pauses from Chat UI, queues supplements, resumes one conversation and shows sidebar activity', async ({
  sharedPage: page,
  electronApp
}, testInfo) => {
  test.setTimeout(180_000)
  const profile = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const workspace = join(profile, 'workflow-chat-folder')
  await mkdir(workspace)
  const script = join(workspace, 'cli.cjs')
  const ledger = join(workspace, 'calls.jsonl')
  await writeFile(
    script,
    `
const {appendFileSync}=require('node:fs');
const args=process.argv.slice(2), resumed=args.includes('--session-id');
const id=resumed?args[args.indexOf('--session-id')+1]:'workflow-chat-session';
appendFileSync(${JSON.stringify(ledger)},JSON.stringify({id,resumed,prompt:args.at(-1)})+'\\n');
console.log(JSON.stringify({type:'session',sessionId:id}));
console.log(JSON.stringify({type:'status',phase:'turn_start'}));
console.log(JSON.stringify({type:'tool_call',tool:'shell',input:{command:'verify-demo'}}));
if(resumed) {
 console.log(JSON.stringify({type:'final',text:JSON.stringify({outcome:'succeeded',body:'Verified resumed conversation',filesModified:[]})}));
} else setInterval(()=>{},1000);
`
  )
  const id = randomUUID()
  await page.evaluate(
    async ({ workspace, script, program, id }) => {
      await window.api.settings.set({
        agentCmdOverrides: { dsh: program },
        agentDefaultArgs: { dsh: JSON.stringify(script) },
        disabledTuiAgents: [],
        experimentalNativeChat: false
      })
      const group = await window.api.projectGroups.create({
        name: 'Workflow chat',
        parentPath: workspace
      })
      const folder = await window.api.folderWorkspaces.create({
        projectGroupId: group.id,
        name: 'Workflow chat',
        folderPath: workspace
      })
      window.__store?.getState().setActiveWorktree(`folder:${folder.id}`)
      const result = await window.api.runtime.call({
        method: 'workflow.start',
        params: {
          id,
          worktree: `id:folder:${folder.id}`,
          input: 'Verify Chat UI controls',
          definition: {
            version: 1,
            name: 'Chat controls',
            entry: 'develop',
            maxSteps: 2,
            nodes: [
              {
                id: 'develop',
                type: 'agent',
                agent: 'dsh',
                prompt: 'Develop',
                onSuccess: 'done',
                onFailure: 'failed'
              },
              { id: 'done', type: 'end', outcome: 'succeeded' },
              { id: 'failed', type: 'end', outcome: 'failed' }
            ]
          }
        }
      })
      if (!result.ok) {
        throw new Error(result.error.message)
      }
      window.dispatchEvent(new Event('workspace-session-history-changed'))
    },
    { workspace, script, program: process.execPath, id }
  )
  await expect
    .poll(async () => readFile(ledger, 'utf8').catch(() => ''))
    .toContain('workflow-chat-session')
  await page.evaluate(() => window.dispatchEvent(new Event('workspace-session-history-changed')))
  const history = page.locator('[data-workspace-session-history]')
  const group = history.locator('[data-session-agent-group="dsh"]')
  await expect(group).toBeVisible()
  await group.getByRole('button').first().click()
  const row = history.locator('[data-session-history-row]').first()
  await expect(row.getByRole('status', { name: /Agent running|智能体正在运行/ })).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(row.locator('[data-session-row-actions]')).toHaveCSS('opacity', '0')
  await row.locator('[data-workflow-session-row]').click()
  const session = page.getByTestId('workflow-session-view')
  await expect(session).toBeVisible()
  await expect(session.getByTestId('workflow-session-composer')).toHaveCount(0)
  await page.evaluate(async () => {
    await window.__store?.getState().updateSettings({ experimentalNativeChat: true })
  })
  const composer = session.getByTestId('workflow-session-composer')
  await expect(composer).toBeVisible()
  await expect(session.locator('[data-session-native-transcript]').first()).toContainText(
    'verify-demo'
  )
  await composer.getByRole('button', { name: /Interrupt workflow|打断工作流/ }).click()
  await expect(composer.getByRole('button', { name: /Resume|恢复/, exact: true })).toBeVisible()
  await expect(row.getByRole('status', { name: /Agent running|智能体正在运行/ })).toHaveCount(0)
  expect((await readFile(ledger, 'utf8')).trim().split('\n')).toHaveLength(1)
  const editor = composer.locator('[contenteditable="true"]')
  await editor.fill('Keep keyboard controls and verify the result.')
  await composer.getByRole('button', { name: /Send supplement|发送补充消息/ }).click()
  await expect(composer).toContainText('Keep keyboard controls and verify the result.')
  expect((await readFile(ledger, 'utf8')).trim().split('\n')).toHaveLength(1)
  await page.screenshot({ path: testInfo.outputPath('workflow-chat-paused.png') })
  await composer.getByRole('button', { name: /Resume|恢复/, exact: true }).click()
  await expect(session).toContainText('Verified resumed conversation', { timeout: 30_000 })
  await expect(composer).toHaveCount(0)
  await expect(row.getByRole('status', { name: /Agent running|智能体正在运行/ })).toHaveCount(0)
  const calls = (await readFile(ledger, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(calls).toHaveLength(2)
  expect(calls[0].id).toBe(calls[1].id)
  expect(calls[1].resumed).toBe(true)
  expect(calls[1].prompt).toContain('Keep keyboard controls and verify the result.')
  await page.screenshot({ path: testInfo.outputPath('workflow-chat-complete.png') })
})
