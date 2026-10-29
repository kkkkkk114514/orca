import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AiVaultSession } from '../../../shared/ai-vault-types'
import { WorkspaceSessionArchive } from './workspace-session-archive'
import { workspaceSessionInventory } from './workspace-session-inventory'
import { WorkflowHeadlessReceipts } from './workflow-headless-receipts'
import { workflowRunPaths } from './workflow-report-paths'
import { createWorkflowExecution } from '../../../shared/workflow-executor'
import { workflowDefinitionSchema } from '../../../shared/workflow-definition'
import { readWorkspaceSession } from './workspace-session-history'
import { isStructuredTab } from '../../../shared/structured-agent-session-tab'
import {
  isReadOnlySessionView,
  parseWorkspaceHistoryView,
  workspaceHistoryViewId
} from '../../../shared/workspace-session-history'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workspace-history-'))
  roots.push(root)
  await mkdir(join(root, 'receipts'))
  return {
    root,
    owner: 'desktop',
    workspace: { id: 'folder:test', path: '/repo/app' },
    native: [],
    receipts: new WorkflowHeadlessReceipts(join(root, 'receipts'))
  }
}
function native(cwd = '/repo/app', sessionId = 'native-test'): AiVaultSession {
  return {
    id: `local:codex:${sessionId}`,
    executionHostId: 'local',
    agent: 'codex',
    sessionId,
    title: 'A normal conversation',
    cwd,
    filePath: '/sessions/native.jsonl',
    codexHome: null,
    createdAt: '2026-10-26T00:00:00Z',
    updatedAt: null,
    modifiedAt: '2026-10-26T01:00:00Z',
    branch: null,
    model: null,
    messageCount: 2,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  }
}

it('persists reversible archives per caller and workspace without deleting conversation files', async () => {
  const f = await fixture()
  const store = new WorkspaceSessionArchive(join(f.root, 'archives'))
  const key = 'a'.repeat(64)
  const path = join(f.root, 'conversation.jsonl')
  await writeFile(path, 'conversation')
  await Promise.all([
    store.set('one', 'workspace', key, true),
    store.set('one', 'workspace', 'b'.repeat(64), true)
  ])
  const reopened = new WorkspaceSessionArchive(join(f.root, 'archives'))
  expect(Object.keys(await reopened.read('one', 'workspace'))).toHaveLength(2)
  expect(await reopened.read('other', 'workspace')).toEqual({})
  expect(await reopened.read('one', 'other-workspace')).toEqual({})
  await reopened.set('one', 'workspace', key, false)
  expect((await reopened.read('one', 'workspace'))[key]).toBeUndefined()
  expect(await readFile(path, 'utf8')).toBe('conversation')
})

it('lists only the exact workspace and deduplicates regular CLI history rows', async () => {
  const f = await fixture()
  const result = await workspaceSessionInventory({
    ...f,
    native: [
      native(),
      native(),
      native('/repo/app-other', 'sibling'),
      native('/repo/app/sub', 'child')
    ]
  })
  expect(result.items).toHaveLength(1)
  expect(result.items[0]?.row.source).toBe('cli')
  expect(
    (
      await workspaceSessionInventory({
        ...f,
        workspace: { ...f.workspace, path: '/other' },
        native: [native()]
      })
    ).items
  ).toHaveLength(0)
})

it('retains closed Workflow node history and omits its duplicate native transcript', async () => {
  const f = await fixture()
  const id = randomUUID()
  const paths = workflowRunPaths(f.root, f.owner, id)
  await mkdir(paths.directory, { recursive: true })
  const definition = workflowDefinitionSchema.parse({
    version: 1,
    name: 'Test',
    entry: 'develop',
    maxSteps: 2,
    nodes: [
      {
        id: 'develop',
        type: 'agent',
        agent: 'codex',
        prompt: 'Develop',
        onSuccess: 'done',
        onFailure: 'done'
      },
      { id: 'done', type: 'end', outcome: 'succeeded' }
    ]
  })
  const state = createWorkflowExecution(
    definition,
    'Make a demo',
    { worktree: 'id:folder:test', from: 'term_coordinator', target: f.owner },
    'runtime'
  )
  state.runId = 'run_test'
  state.status = 'succeeded'
  state.cursor = 'done'
  state.steps.push({
    nodeId: 'develop',
    startRequestId: randomUUID(),
    startRuntimeId: 'runtime',
    releaseRequestId: randomUUID(),
    taskId: 'task_test',
    dispatchId: 'ctx_test',
    released: true,
    report: { outcome: 'succeeded', messageId: 'message', body: 'Verified', filesModified: [] }
  })
  await writeFile(
    paths.metadata,
    JSON.stringify({
      request: { id, worktree: 'id:folder:test', input: state.input, definition },
      createdAt: Date.now(),
      coordinator: 'term_coordinator',
      paused: false
    })
  )
  await writeFile(paths.checkpoint, JSON.stringify(state))
  f.receipts.save({
    dispatchId: 'ctx_test',
    taskId: 'task_test',
    handle: 'term_worker',
    coordinator: 'term_coordinator',
    paneKey: 'pane',
    processIncarnation: 'process',
    settlementRequestId: randomUUID(),
    status: 'settled',
    sessionId: 'native-test',
    binding: {
      runId: 'run_test',
      nodeId: 'develop',
      workspaceId: 'folder:test',
      agent: 'codex',
      configurationKey: 'a'.repeat(64)
    }
  })
  const result = await workspaceSessionInventory({ ...f, native: [native()] })
  expect(result.items).toHaveLength(1)
  expect(result.items[0]?.row).toMatchObject({
    source: 'workflow',
    workflow: { id, nodeId: 'develop' }
  })
  expect((await workspaceSessionInventory({ ...f, owner: 'other', native: [] })).items).toEqual([])
  state.status = 'running'
  state.cursor = 'develop'
  state.steps[0].released = false
  await writeFile(paths.checkpoint, JSON.stringify(state))
  await writeFile(
    paths.metadata,
    JSON.stringify({
      request: { id, worktree: 'id:folder:test', input: state.input, definition },
      createdAt: Date.now(),
      coordinator: 'term_coordinator',
      paused: false,
      conversations: {
        develop: {
          key: 'b'.repeat(64),
          agent: 'codex',
          workspaceId: 'folder:test',
          sessionId: 'resumed-session'
        }
      }
    })
  )
  expect((await workspaceSessionInventory({ ...f })).busySessions).toEqual(
    new Set(['codex:resumed-session', 'codex:native-test'])
  )
})

it('reads native history without launching a session and omits reasoning', async () => {
  const f = await fixture()
  const filePath = join(f.root, 'codex.jsonl')
  await writeFile(
    filePath,
    `${[
      { type: 'event_msg', payload: { type: 'user_message', message: 'Original task' } },
      { type: 'event_msg', payload: { type: 'agent_reasoning', text: 'private reasoning' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Public answer' } },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell_command',
          call_id: 'call-1',
          arguments: JSON.stringify({ command: 'npm test' })
        }
      },
      {
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-1', output: 'All tests passed' }
      }
    ]
      .map((event) => JSON.stringify(event))
      .join('\n')}\n`
  )
  const page = await readWorkspaceSession({
    native: { ...native(), filePath },
    row: {
      key: 'a'.repeat(64),
      agent: 'codex',
      title: 'Test',
      updatedAt: 0,
      archived: false,
      source: 'cli'
    }
  })
  expect(page.entries.map((entry) => entry.text).join('\n')).toContain('Public answer')
  expect(page.entries.map((entry) => entry.text).join('\n')).not.toContain('private reasoning')
  expect(page.entries.flatMap((entry) => entry.blocks ?? [])).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'tool-call',
        callId: 'call-1',
        input: { command: 'npm test' }
      }),
      expect.objectContaining({ type: 'tool-result', callId: 'call-1', output: 'All tests passed' })
    ])
  )
})

it('keeps valid and malformed read-only history tabs outside provider session lifecycle', () => {
  const entityId = workspaceHistoryViewId('a'.repeat(64))
  expect(parseWorkspaceHistoryView(entityId)).toBe('a'.repeat(64))
  expect(
    isStructuredTab({ contentType: 'agent-session', agentSessionAgent: 'codex', entityId })
  ).toBe(false)
  expect(isReadOnlySessionView('workspace-history:invalid')).toBe(true)
  expect(parseWorkspaceHistoryView('workspace-history:invalid')).toBeNull()
})
