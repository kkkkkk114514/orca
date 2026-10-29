import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { createUuidV4 } from '../../../shared/uuid-v4'
import { WorkflowHeadlessReceipts, type SavedHeadlessWorker } from './workflow-headless-receipts'
import { executeWorkflowHeadlessInvocation } from './workflow-headless-invocation'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))
const roots: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it.each([false, true])(
  'only makes an interrupted invocation resumable when termination is confirmed (%s)',
  async (confirmed) => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-interrupt-'))
    roots.push(root)
    const receipts = new WorkflowHeadlessReceipts(root)
    const abort = new AbortController()
    const saved: SavedHeadlessWorker = {
      dispatchId: 'ctx_interrupted',
      taskId: 'task_test',
      handle: 'term_test',
      coordinator: 'term_coord',
      paneKey: 'pane_test',
      processIncarnation: 'inc_test',
      settlementRequestId: createUuidV4(),
      status: 'running'
    }
    const settle = vi.fn(async () => {})
    vi.mocked(runProcess).mockImplementation(async (spec) => {
      spec.onStdout?.(
        Buffer.from(`${JSON.stringify({ type: 'session', sessionId: 'same-session' })}\n`)
      )
      abort.abort('workflow-user-interrupt')
      if (confirmed) {
        spec.onChildTerminated?.()
      }
      return { code: null, signal: null, stdout: '', stderr: '', timedOut: false }
    })
    await executeWorkflowHeadlessInvocation({
      runtime: { getOrchestrationDb: () => ({ getDispatchContextById: () => undefined }) },
      saved,
      agent: 'dsh',
      command: { program: 'fake-cli', signal: abort.signal },
      abort,
      receipts,
      assertAuthority: () => {},
      settle
    })
    expect((await receipts.read(saved.dispatchId)).status).toBe(confirmed ? 'paused' : 'error')
    expect(saved.sessionId).toBe('same-session')
    expect(settle).not.toHaveBeenCalled()
    if (!confirmed) {
      expect(saved.error).toContain('termination could not be confirmed')
    }
  }
)
