import { describe, expect, it } from 'vitest'
import { workflowDefinitionSchema } from './workflow-definition'
import {
  workflowExecutionSchema,
  type WorkflowExecution,
  type WorkflowStepReport
} from './workflow-execution'
import { advanceWorkflow, createWorkflowExecution, type WorkflowRuntime } from './workflow-executor'

const definition = workflowDefinitionSchema.parse({
  version: 1,
  name: 'Repair loop',
  entry: 'develop',
  maxSteps: 4,
  nodes: [
    {
      id: 'develop',
      type: 'agent',
      agent: 'dsh',
      prompt: 'Develop',
      onSuccess: 'test',
      onFailure: 'failed'
    },
    {
      id: 'test',
      type: 'agent',
      agent: 'zcode',
      prompt: 'Test',
      onSuccess: 'done',
      onFailure: 'develop'
    },
    { id: 'done', type: 'end', outcome: 'succeeded' },
    { id: 'failed', type: 'end', outcome: 'failed' }
  ]
})

function fixture(outcomes: ('succeeded' | 'failed')[] = []) {
  let stored = ''
  const starts: { node: string; request: string; handoff?: WorkflowStepReport }[] = []
  const releases: string[] = []
  const reports = new Map<string, WorkflowStepReport>()
  const runtime: WorkflowRuntime = {
    runtimeId: 'runtime-one',
    async createRun() {
      return 'run-one'
    },
    async startStep(state, step, node) {
      starts.push({
        node: node.id,
        request: step.startRequestId,
        handoff: state.steps.at(-2)?.report
      })
      const dispatchId = `dispatch-${starts.length}`
      const outcome = outcomes.shift()
      if (outcome) {
        reports.set(dispatchId, {
          outcome,
          messageId: `message-${starts.length}`,
          body: `revision-${starts.length}: actual test result`,
          filesModified: ['average.mjs']
        })
      }
      return { taskId: `task-${starts.length}`, dispatchId }
    },
    async inspectStep(_state, step) {
      const report = reports.get(step.dispatchId ?? '')
      return report ? { report } : { waiting: 'No authoritative report' }
    },
    async releaseStep(step) {
      releases.push(step.releaseRequestId)
      return true
    }
  }
  const state = createWorkflowExecution(
    definition,
    'Implement average',
    { worktree: 'folder:example', from: 'term-coordinator', target: 'local-target' },
    runtime.runtimeId
  )
  async function save(value: WorkflowExecution) {
    stored = JSON.stringify(workflowExecutionSchema.parse(value))
  }
  return {
    runtime,
    state,
    save,
    load: () => workflowExecutionSchema.parse(JSON.parse(stored)),
    starts,
    releases,
    reports
  }
}

describe('workflow executor', () => {
  it('routes development, failed QA, repair and passing QA, handing off accepted evidence', async () => {
    const f = fixture(['succeeded', 'failed', 'succeeded', 'succeeded'])
    const result = await advanceWorkflow(f.state, f.runtime, f.save)
    expect(result).toMatchObject({ state: { status: 'succeeded', cursor: 'done' }, waiting: null })
    expect(f.starts.map((step) => step.node)).toEqual(['develop', 'test', 'develop', 'test'])
    expect(f.starts[2].handoff).toMatchObject({
      outcome: 'failed',
      body: 'revision-2: actual test result'
    })
    expect(f.load().steps.every((step) => step.released)).toBe(true)
    expect(new Set(f.releases).size).toBe(4)
  })

  it('exhausts the budget across repair visits, without launching one extra worker', async () => {
    const f = fixture(['succeeded', 'failed', 'succeeded', 'failed', 'succeeded'])
    const result = await advanceWorkflow(f.state, f.runtime, f.save)
    expect(result.state).toMatchObject({
      status: 'failed',
      reason: 'step_limit',
      cursor: 'develop'
    })
    expect(f.starts).toHaveLength(4)
    await advanceWorkflow(f.load(), f.runtime, f.save)
    expect(f.starts).toHaveLength(4)
  })

  it('does not confuse an absent completion report with a business failure', async () => {
    const f = fixture()
    const first = await advanceWorkflow(f.state, f.runtime, f.save)
    expect(first.waiting).toBe('No authoritative report')
    const resumed = f.load()
    await advanceWorkflow(resumed, f.runtime, f.save)
    expect(f.starts).toHaveLength(1)
    expect(resumed).toMatchObject({ status: 'running', cursor: 'develop' })
    f.reports.set('dispatch-1', {
      outcome: 'failed',
      messageId: 'failure',
      body: 'Test failed',
      filesModified: []
    })
    await advanceWorkflow(resumed, f.runtime, f.save)
    expect(resumed).toMatchObject({ status: 'failed', cursor: 'failed' })
  })

  it('keeps the start request persisted before an ambiguous RPC and reuses it on resume', async () => {
    const f = fixture()
    let attempted = ''
    f.runtime.startStep = async (_state, step) => {
      expect(f.load().steps.at(-1)?.startRequestId).toBe(step.startRequestId)
      attempted = step.startRequestId
      throw new Error('Response lost after the remote runtime accepted the request')
    }
    await expect(advanceWorkflow(f.state, f.runtime, f.save)).rejects.toThrow('Response lost')
    const recovered = f.load()
    f.runtime.startStep = async (_state, step) => {
      expect(step.startRequestId).toBe(attempted)
      return { taskId: 'original-task', dispatchId: 'original-dispatch' }
    }
    await advanceWorkflow(recovered, f.runtime, f.save)
    expect(f.load().steps).toHaveLength(1)
    expect(f.load().steps[0]).toMatchObject({
      taskId: 'original-task',
      dispatchId: 'original-dispatch'
    })
  })

  it('reuses the run request after a lost create response and refuses another runtime', async () => {
    const f = fixture()
    const id = f.state.runRequestId
    f.runtime.createRun = async (state) => {
      expect(f.load().runRequestId).toBe(id)
      expect(state.runRequestId).toBe(id)
      throw new Error('Lost run receipt')
    }
    await expect(advanceWorkflow(f.state, f.runtime, f.save)).rejects.toThrow('Lost run receipt')
    const recovered = f.load()
    f.runtime.runtimeId = 'different-runtime'
    await expect(advanceWorkflow(recovered, f.runtime, f.save)).rejects.toThrow('runtime changed')
    expect(f.starts).toHaveLength(0)
  })

  it('persists a report before cleanup and never advances while release is uncertain', async () => {
    const f = fixture(['succeeded'])
    f.runtime.releaseStep = async (step) => {
      expect(f.load().steps[0].report?.outcome).toBe('succeeded')
      f.releases.push(step.releaseRequestId)
      return false
    }
    await advanceWorkflow(f.state, f.runtime, f.save)
    expect(f.load().cursor).toBe('develop')
    f.runtime.inspectStep = async (_state, step) => {
      if (step.dispatchId === 'dispatch-1') {
        throw new Error('Persisted evidence must not be overwritten')
      }
      return { waiting: 'Next step running' }
    }
    const retry = f.load()
    await advanceWorkflow(retry, f.runtime, f.save)
    expect(f.starts).toHaveLength(1)
    expect(f.releases[0]).toBe(f.releases[1])
    f.runtime.releaseStep = async () => true
    await advanceWorkflow(retry, f.runtime, f.save)
    expect(f.load().cursor).toBe('test')
    expect(f.starts).toHaveLength(2)
  })

  it('starts no worker if the write-ahead checkpoint fails', async () => {
    const f = fixture()
    await expect(
      advanceWorkflow(f.state, f.runtime, async () => {
        throw new Error('Disk full')
      })
    ).rejects.toThrow('Disk full')
    expect(f.starts).toHaveLength(0)
  })

  it('finishes an end-only workflow without scheduling an agent', async () => {
    const f = fixture()
    f.state = createWorkflowExecution(
      workflowDefinitionSchema.parse({
        version: 1,
        name: 'Done',
        entry: 'done',
        maxSteps: 1,
        nodes: [{ id: 'done', type: 'end', outcome: 'succeeded' }]
      }),
      '',
      f.state.context,
      f.runtime.runtimeId
    )
    await advanceWorkflow(f.state, f.runtime, f.save)
    expect(f.load().status).toBe('succeeded')
    expect(f.starts).toHaveLength(0)
  })

  it('rejects checkpoints whose cursor, budget, worker identities or path were tampered with', async () => {
    const f = fixture(['succeeded', 'failed', 'succeeded', 'succeeded'])
    await advanceWorkflow(f.state, f.runtime, f.save)
    for (const change of [
      (s: WorkflowExecution) => {
        s.cursor = 'failed'
      },
      (s: WorkflowExecution) => {
        s.steps[1].dispatchId = s.steps[0].dispatchId
      },
      (s: WorkflowExecution) => {
        s.steps[0].nodeId = 'test'
      },
      (s: WorkflowExecution) => {
        s.definition.maxSteps = 1
      },
      (s: WorkflowExecution) => {
        s.steps[1].released = false
      }
    ]) {
      const invalid = structuredClone(f.state)
      change(invalid)
      expect(workflowExecutionSchema.safeParse(invalid).success).toBe(false)
    }
  })
})
