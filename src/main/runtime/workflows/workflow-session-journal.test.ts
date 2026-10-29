import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { WorkflowSessionJournal, readWorkflowSessionJournal } from './workflow-session-journal'
import { WorkflowOutputActivity } from './workflow-output-activity'
import type { WorkflowSessionEntry } from '../../../shared/workflow-session-view'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('retains public output beyond the activity tail and pages Chinese text without loss', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-record-'))
  roots.push(root)
  const path = join(root, 'session.jsonl')
  const journal = new WorkflowSessionJournal(path)
  const activity = new WorkflowOutputActivity('ctx_test', undefined, (text) => journal.append(text))
  for (let index = 0; index < 125; index++) {
    activity.stdout(
      `${JSON.stringify({ type: 'text', text: `消息${index} ${'开发记录'.repeat(3000)}` })}\n`
    )
    activity.stdout(`${JSON.stringify({ type: 'reasoning', text: 'PRIVATE_REASONING' })}\n`)
  }
  expect(activity.value.entries).toHaveLength(30)
  const entries: WorkflowSessionEntry[] = []
  let before: number | undefined
  for (;;) {
    const page = await readWorkflowSessionJournal(path, before)
    if (!page) {
      throw new Error('Missing journal')
    }
    entries.unshift(...page.entries)
    if (!page.hasMore) {
      break
    }
    expect(page.before).toBeLessThan(before ?? Infinity)
    before = page.before
  }
  expect(entries).toHaveLength(126)
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(126)
  expect(entries[1]?.text).toContain('消息0')
  expect(entries.at(-1)?.text).toContain('消息124')
  expect(JSON.stringify(entries)).not.toContain('PRIVATE_REASONING')
})

it('bounds storage and reports truncation, tolerating an unfinished final record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-record-'))
  roots.push(root)
  const path = join(root, 'session.jsonl')
  const journal = new WorkflowSessionJournal(path)
  for (let index = 0; index < 1100; index++) {
    journal.append('x'.repeat(16_000))
  }
  const page = await readWorkflowSessionJournal(path)
  expect(page?.limited).toBe(true)
  await writeFile(path, '{"id":"unfinished"')
  expect((await readWorkflowSessionJournal(path))?.entries).toEqual([])
  expect(await readWorkflowSessionJournal(join(root, 'missing'))).toBeUndefined()
})

it('records headless tool arguments, results and Codex item updates for native chat rendering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-structured-record-'))
  roots.push(root)
  const path = join(root, 'session.jsonl')
  const journal = new WorkflowSessionJournal(path)
  const activity = new WorkflowOutputActivity('ctx_test', undefined, (text, message) =>
    journal.append(text, message)
  )
  for (const event of [
    {
      type: 'tool_call',
      tool: 'Write',
      call_id: 'write-1',
      input: { path: 'demo.ts', content: 'export const demo = 1', api_key: 'private-key' }
    },
    { type: 'tool_result', call_id: 'write-1', status: 'completed', result: 'File created' },
    { type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'npm test' } },
    {
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'npm test',
        aggregated_output: 'Tests passed',
        status: 'completed'
      }
    },
    {
      type: 'item.completed',
      item: {
        id: 'edit-1',
        type: 'file_change',
        status: 'completed',
        changes: [{ path: 'demo.ts', kind: 'update', diff: '@@ -1 +1 @@\n-before\n+after' }]
      }
    }
  ]) {
    activity.stdout(`${JSON.stringify(event)}\n`)
  }
  const page = await readWorkflowSessionJournal(path)
  expect(page?.entries[1]?.blocks).toMatchObject([
    {
      type: 'tool-call',
      callId: 'write-1',
      input: { path: 'demo.ts', content: 'export const demo = 1' }
    }
  ])
  expect(page?.entries[2]?.blocks).toMatchObject([
    { type: 'tool-result', callId: 'write-1', output: 'File created' }
  ])
  const latest = [...new Map(page?.entries.map((entry) => [entry.id, entry])).values()]
  expect(latest.filter((entry) => entry.id === 'provider:cmd-1')).toHaveLength(1)
  expect(latest.find((entry) => entry.id === 'provider:cmd-1')?.blocks).toMatchObject([
    { type: 'tool-call', state: 'completed', callId: 'cmd-1' },
    { type: 'tool-result', callId: 'cmd-1', output: 'Tests passed' }
  ])
  expect(latest.at(-1)?.blocks).toMatchObject([
    { name: 'apply_patch', input: { changes: [{ path: 'demo.ts' }] } }
  ])
  activity.stdout(
    `${JSON.stringify({ type: 'item.completed', item: { id: 'failed-cmd', type: 'command_execution', command: 'npm test', status: 'completed', exit_code: 1, aggregated_output: 'Test failed' } })}\n`
  )
  expect((await readWorkflowSessionJournal(path))?.entries.at(-1)?.blocks).toMatchObject([
    { type: 'tool-call', state: 'failed' },
    { type: 'tool-result', isError: true, output: 'Test failed' }
  ])
  expect(JSON.stringify(page)).not.toContain('private-key')
})
