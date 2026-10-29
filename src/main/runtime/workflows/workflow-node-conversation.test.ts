import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkflowExecution } from '../../../shared/workflow-executor'
import { workflowDefinitionSchema } from '../../../shared/workflow-definition'
import { WorkflowHeadlessReceipts, type SavedHeadlessWorker } from './workflow-headless-receipts'
import { WorkflowSessionJournal } from './workflow-session-journal'
import { readWorkflowNodeConversation } from './workflow-node-conversation'
import { readNativeChatTranscriptTail } from '../../native-chat/transcript-tail-reader'

vi.mock('../../native-chat/transcript-tail-reader', () => ({
  readNativeChatTranscriptTail: vi.fn()
}))
const roots: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(agent: 'dsh' | 'codex' = 'dsh') {
  const root = await mkdtemp(join(tmpdir(), 'workflow-session-'))
  roots.push(root)
  const definition = workflowDefinitionSchema.parse({
    version: 1,
    name: 'Records',
    entry: 'develop',
    maxSteps: 2,
    nodes: [
      {
        id: 'develop',
        type: 'agent',
        agent,
        prompt: 'Develop',
        onSuccess: 'done',
        onFailure: 'done'
      },
      { id: 'done', type: 'end', outcome: 'succeeded' }
    ]
  })
  const execution = createWorkflowExecution(
    definition,
    'Task',
    { worktree: 'id:folder:project', from: 'term_owner', target: 'desktop' },
    'runtime'
  )
  execution.runId = 'run_actual'
  const step = {
    nodeId: 'develop',
    startRequestId: execution.runRequestId,
    startRuntimeId: 'runtime',
    releaseRequestId: execution.runRequestId,
    taskId: 'task_actual',
    dispatchId: 'ctx_actual',
    released: false
  }
  const saved: SavedHeadlessWorker = {
    handle: 'worker_actual',
    coordinator: 'term_owner',
    taskId: 'task_actual',
    dispatchId: 'ctx_actual',
    paneKey: 'pane',
    processIncarnation: 'incarnation',
    settlementRequestId: execution.runRequestId,
    status: 'running',
    binding: {
      runId: 'run_actual',
      nodeId: 'develop',
      workspaceId: 'folder:project',
      agent,
      configurationKey: 'a'.repeat(64)
    }
  }
  const receipts = new WorkflowHeadlessReceipts(root)
  receipts.save(saved)
  return { receipts, execution, step, saved }
}

it('reads the dispatch journal live and fences foreign run, node, workspace and coordinator receipts', async () => {
  const f = await fixture()
  new WorkflowSessionJournal(`${f.receipts.path('ctx_actual')}.conversation.jsonl`).append(
    'Live tool result'
  )
  expect(await readWorkflowNodeConversation(f.receipts, f.execution, f.step)).toMatchObject({
    source: 'journal',
    entries: [{ text: 'Live tool result' }]
  })
  expect(readNativeChatTranscriptTail).not.toHaveBeenCalled()
  for (const mismatch of [
    { runId: 'run_other' },
    { nodeId: 'test' },
    { workspaceId: 'folder:other' }
  ]) {
    f.receipts.save({ ...f.saved, binding: f.saved.binding && { ...f.saved.binding, ...mismatch } })
    await expect(readWorkflowNodeConversation(f.receipts, f.execution, f.step)).rejects.toThrow(
      'binding mismatch'
    )
  }
  f.receipts.save({ ...f.saved, coordinator: 'term_other' })
  await expect(readWorkflowNodeConversation(f.receipts, f.execution, f.step)).rejects.toThrow(
    'binding mismatch'
  )
})

it('uses only the bound legacy provider session and excludes reasoning from transcript pages', async () => {
  const f = await fixture('codex')
  f.receipts.save({ ...f.saved, sessionId: 'session-actual' })
  vi.mocked(readNativeChatTranscriptTail).mockResolvedValue({
    messages: [
      {
        id: 'public',
        role: 'assistant',
        source: 'transcript',
        timestamp: null,
        blocks: [{ type: 'text', text: 'Public message' }]
      },
      {
        id: 'private',
        role: 'reasoning',
        source: 'transcript',
        timestamp: null,
        blocks: [{ type: 'text', text: 'PRIVATE_REASONING' }]
      }
    ],
    hasMore: true,
    beforeOffset: 128
  })
  const page = await readWorkflowNodeConversation(f.receipts, f.execution, f.step, 1024)
  expect(readNativeChatTranscriptTail).toHaveBeenCalledWith({
    agent: 'codex',
    sessionId: 'session-actual',
    limit: 50,
    beforeOffset: 1024
  })
  expect(page.entries.map((entry) => entry.text)).toEqual(['Public message'])
  expect(page).toMatchObject({ source: 'transcript', before: 128, hasMore: true })
})

it('labels legacy activity as partial and does not substitute another session for missing output', async () => {
  const f = await fixture()
  expect(await readWorkflowNodeConversation(f.receipts, f.execution, f.step)).toMatchObject({
    source: 'unavailable',
    entries: []
  })
  f.receipts.saveActivity({
    dispatchId: 'ctx_actual',
    startedAt: 1,
    state: 'finished',
    omitted: 20,
    entries: [{ id: 21, at: 2, text: 'Available tail' }]
  })
  expect(await readWorkflowNodeConversation(f.receipts, f.execution, f.step)).toMatchObject({
    source: 'activity',
    limited: true,
    entries: [{ text: 'Available tail' }]
  })
})

it('recovers structured CLI history instead of using a completed legacy text journal', async () => {
  const f = await fixture('codex')
  f.receipts.save({ ...f.saved, sessionId: 'session-actual', status: 'settled' })
  new WorkflowSessionJournal(`${f.receipts.path('ctx_actual')}.conversation.jsonl`).append(
    'Old flattened command and output'
  )
  vi.mocked(readNativeChatTranscriptTail).mockResolvedValue({
    messages: [
      {
        id: 'call',
        role: 'assistant',
        source: 'transcript',
        timestamp: null,
        blocks: [{ type: 'tool-call', name: 'exec', callId: 'call-actual', input: 'run tests' }]
      },
      {
        id: 'result',
        role: 'tool',
        source: 'transcript',
        timestamp: null,
        blocks: [{ type: 'tool-result', callId: 'call-actual', output: '23 tests passed' }]
      }
    ],
    hasMore: true,
    beforeOffset: 400
  })
  const page = await readWorkflowNodeConversation(f.receipts, f.execution, f.step, 800)
  expect(page).toMatchObject({
    source: 'transcript',
    hasMore: true,
    before: 400,
    entries: [
      { blocks: [{ type: 'tool-call', callId: 'call-actual' }] },
      { blocks: [{ type: 'tool-result', callId: 'call-actual' }] }
    ]
  })
  expect(readNativeChatTranscriptTail).toHaveBeenCalledWith({
    agent: 'codex',
    sessionId: 'session-actual',
    limit: 50,
    beforeOffset: 800
  })
  vi.mocked(readNativeChatTranscriptTail).mockResolvedValue({ error: 'Transcript unavailable' })
  expect(await readWorkflowNodeConversation(f.receipts, f.execution, f.step)).toMatchObject({
    source: 'journal',
    limited: true,
    entries: [{ text: 'Old flattened command and output' }]
  })
})
