import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { expect, test } from './helpers/orca-app'

test.use({ seedTestRepo: false })

test('shows legacy workflow history as collapsed native tool cards without starting another CLI', async ({
  sharedPage: page,
  electronApp
}, testInfo) => {
  test.setTimeout(150_000)
  const profile = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
  const workspace = join(profile, 'legacy-chat-workspace')
  await mkdir(workspace)
  const sessionId = randomUUID()
  const script = join(workspace, 'fake-codex.cjs')
  const ledger = join(workspace, 'launches.txt')
  await writeFile(
    script,
    `
require('node:fs').appendFileSync(${JSON.stringify(ledger)}, 'started\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(sessionId)}}));
console.log(JSON.stringify({type:'turn.started'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({outcome:'succeeded',body:'Legacy work complete',filesModified:[]})}}));
console.log(JSON.stringify({type:'turn.completed'}));
`
  )
  const id = randomUUID()
  await page.evaluate(
    async ({ workspace, script, program, id }) => {
      await window.__store?.getState().updateSettings({
        experimentalNativeChat: true,
        agentCmdOverrides: { codex: program },
        agentDefaultArgs: { codex: JSON.stringify(script) },
        disabledTuiAgents: []
      })
      const group = await window.api.projectGroups.create({
        name: 'Legacy history',
        parentPath: workspace
      })
      const folder = await window.api.folderWorkspaces.create({
        projectGroupId: group.id,
        name: 'Legacy history',
        folderPath: workspace
      })
      window.__store?.getState().setActiveWorktree(`folder:${folder.id}`)
      const result = await window.api.runtime.call({
        method: 'workflow.start',
        params: {
          id,
          worktree: `id:folder:${folder.id}`,
          input: 'Old task from this workspace',
          definition: {
            version: 1,
            name: 'Legacy history',
            entry: 'develop',
            maxSteps: 2,
            nodes: [
              {
                id: 'develop',
                type: 'agent',
                agent: 'codex',
                prompt: 'Work',
                onSuccess: 'done',
                onFailure: 'done'
              },
              { id: 'done', type: 'end', outcome: 'succeeded' }
            ]
          }
        }
      })
      if (!result.ok) {
        throw new Error(result.error.message)
      }
    },
    { workspace, script, program: process.execPath, id }
  )
  const snapshot = async () => {
    const response = await page.evaluate(
      (id) => window.api.runtime.call({ method: 'workflow.show', params: { id } }),
      id
    )
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return z
      .object({
        phase: z.string(),
        execution: z
          .object({ steps: z.array(z.object({ dispatchId: z.string().optional() })) })
          .optional()
      })
      .parse(response.result)
  }
  await expect.poll(async () => (await snapshot()).phase).toBe('succeeded')
  const dispatch = (await snapshot()).execution?.steps[0]?.dispatchId
  if (!dispatch) {
    throw new Error('Missing legacy dispatch fixture')
  }
  await writeFile(
    join(profile, 'workflow-headless', `${dispatch}.json.conversation.jsonl`),
    `${JSON.stringify({ id: 'legacy', role: 'activity', text: 'RAW_LEGACY_FLATTENED_OUTPUT' })}\n`
  )
  const directory = join(home, '.codex', 'sessions', '2026', '10', '26')
  await mkdir(directory, { recursive: true })
  const records = [
    { type: 'session_meta', payload: { id: sessionId, cwd: workspace } },
    {
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'Old task from this workspace'
      }
    },
    {
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: 'Checking existing files.'
      }
    },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'legacy-command',
        input: 'const result = await tools.exec_command({ cmd: "npm test" }); text(result)'
      }
    },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'legacy-command',
        output: `LEGACY_TOOL_OUTPUT ${'测试'.repeat(60_000)}`
      }
    },
    {
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: 'Legacy final answer'
      }
    }
  ]
  await writeFile(
    join(directory, `rollout-2026-10-26T10-00-00-${sessionId}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
  )
  await page.evaluate(() => window.dispatchEvent(new Event('workspace-session-history-changed')))
  const group = page.locator('[data-workspace-session-history] [data-session-agent-group="codex"]')
  await expect(group).toBeVisible()
  await group.getByRole('button').first().click()
  await group.locator('[data-workflow-session-row]').click()
  const session = page.getByTestId('workflow-session-view')
  await expect(session).toContainText('Legacy final answer')
  await expect(session).not.toContainText('RAW_LEGACY_FLATTENED_OUTPUT')
  await expect(session).not.toContainText('LEGACY_TOOL_OUTPUT')
  await expect(session.getByTestId('workflow-session-composer')).toHaveCount(0)
  const transcript = session.locator('[data-session-native-transcript]')
  await expect(transcript.locator('[data-native-chat-tool-run-members]')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('legacy-chat-collapsed.png') })
  await transcript.locator('button[aria-expanded="false"]').first().click()
  const members = transcript.locator('[data-native-chat-tool-run-members]')
  await expect(members).toBeVisible()
  await members.locator('button[aria-expanded="false"]').first().click()
  await expect(members).toContainText('LEGACY_TOOL_OUTPUT')
  await expect(members.getByText(/^LEGACY_TOOL_OUTPUT/).first()).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('legacy-chat-expanded.png') })
  expect((await readFile(ledger, 'utf8')).trim().split('\n')).toHaveLength(1)
})
