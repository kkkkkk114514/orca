import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowHeadlessReceipts, type SavedHeadlessWorker } from './workflow-headless-receipts'
import type { WorkflowTokenUsage } from '../../../shared/workflow-step-telemetry'

describe('persisted headless invocation counters', () => {
  let root: string | undefined
  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('corrects legacy cumulative receipts and retains raw totals across subsequent resumes', async () => {
    root = await mkdtemp(join(tmpdir(), 'workflow-usage-'))
    const receipts = new WorkflowHeadlessReceipts(root)
    const first = { inputTokens: 53090, cachedInputTokens: 39936, outputTokens: 312 }
    const second = { inputTokens: 108363, cachedInputTokens: 80000, outputTokens: 1016 }
    const secondDelta = { inputTokens: 55273, cachedInputTokens: 40064, outputTokens: 704 }
    const thirdDelta = { inputTokens: 100, cachedInputTokens: 80, outputTokens: 5 }
    const save = (
      dispatchId: string,
      usage: WorkflowTokenUsage,
      sessionMode: 'new' | 'resumed',
      sessionUsage?: WorkflowTokenUsage,
      nodeId = 'develop'
    ): SavedHeadlessWorker => {
      const saved: SavedHeadlessWorker = {
        handle: 'term_worker',
        coordinator: 'term_coordinator',
        taskId: 'task_fixture',
        dispatchId,
        paneKey: 'pane_fixture',
        processIncarnation: 'incarnation_fixture',
        settlementRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        status: 'settled',
        report: { outcome: 'succeeded', body: 'Complete', filesModified: [] },
        binding: {
          runId: 'run_fixture',
          nodeId,
          workspaceId: 'folder:fixture',
          agent: 'codex',
          configurationKey: 'a'.repeat(64)
        },
        sessionId: 'session_fixture',
        sessionUsage,
        telemetry: {
          ...usage,
          dispatchId,
          sessionId: 'session_fixture',
          sessionMode,
          durationMs: 100
        }
      }
      receipts.save(saved)
      return saved
    }
    save('ctx_first', first, 'new')
    save('ctx_second', second, 'resumed')
    expect(
      (await receipts.telemetry(['ctx_first', 'ctx_second'])).map((step) => step.inputTokens)
    ).toEqual([53090, 55273])
    expect((await receipts.telemetry(['ctx_second']))[0]?.inputTokens).toBeNull()
    expect((await receipts.read('ctx_second')).telemetry?.inputTokens).toBe(108363)

    save('ctx_second', secondDelta, 'resumed', second)
    const cumulativeThird = { inputTokens: 108463, cachedInputTokens: 80080, outputTokens: 1021 }
    save('ctx_third', thirdDelta, 'resumed', cumulativeThird)
    expect(
      (await receipts.telemetry(['ctx_first', 'ctx_second', 'ctx_third'])).map((step) => ({
        inputTokens: step.inputTokens,
        cachedInputTokens: step.cachedInputTokens,
        outputTokens: step.outputTokens
      }))
    ).toEqual([first, secondDelta, thirdDelta])
    expect((await receipts.read('ctx_third')).sessionUsage).toEqual(cumulativeThird)

    save('ctx_other', second, 'resumed', undefined, 'test')
    expect((await receipts.telemetry(['ctx_first', 'ctx_other']))[1]?.inputTokens).toBeNull()
  })
})
