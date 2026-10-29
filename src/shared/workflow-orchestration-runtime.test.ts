import { describe, expect, it, vi } from 'vitest'
import { createOrchestrationWorkflowRuntime } from './workflow-orchestration-runtime'
import { advanceWorkflow, createWorkflowExecution } from './workflow-executor'
import { workflowDefinitionSchema } from './workflow-definition'
import { createUuidV4 } from './uuid-v4'

describe('node launch capability boundary', () => {
  it('keeps node instructions before visit data and requests only that node’s prior dispatch', async () => {
    const definition = workflowDefinitionSchema.parse({
      version: 2,
      name: 'Repair',
      entry: 'develop',
      maxSteps: 4,
      nodes: [
        {
          id: 'develop',
          type: 'agent',
          agent: 'codex',
          prompt: 'Stable developer instructions',
          launch: { security: { access: 'workspace-write', approval: 'never' } },
          onSuccess: 'test',
          onFailure: 'done'
        },
        {
          id: 'test',
          type: 'agent',
          agent: 'codex',
          prompt: 'Independent tester instructions',
          onSuccess: 'done',
          onFailure: 'develop'
        },
        { id: 'done', type: 'end', outcome: 'succeeded' }
      ]
    })
    const state = createWorkflowExecution(
      definition,
      'Stable task',
      { from: 'term_coord', worktree: 'folder:fixture', target: 'local' },
      'runtime'
    )
    state.runId = 'run_fixture'
    const call = vi.fn().mockResolvedValue({ taskId: 'task_new', dispatchId: 'ctx_new' })
    const runtime = createOrchestrationWorkflowRuntime({
      runtimeId: 'runtime',
      call,
      assertCurrent: () => {},
      devMode: true,
      nativeNodeLaunch: true,
      error: (_code, message) => new Error(message)
    })
    const step = {
      nodeId: 'develop',
      startRequestId: createUuidV4(),
      startRuntimeId: 'runtime',
      releaseRequestId: createUuidV4(),
      released: false
    }
    state.steps.push(step)
    const node = definition.nodes[0]
    if (node.type !== 'agent') {
      throw new Error('Expected agent')
    }
    await runtime.startStep(state, step, node)
    const initial = call.mock.calls[0][1]
    expect(initial.workflowLaunch).toEqual(node.launch)
    expect(initial.workflowNodeId).toBe('develop')
    const report = {
      outcome: 'failed' as const,
      body: 'Actual QA failure',
      messageId: 'msg_qa',
      filesModified: []
    }
    state.steps.unshift(
      {
        ...step,
        startRequestId: createUuidV4(),
        releaseRequestId: createUuidV4(),
        taskId: 'task_old_dev',
        dispatchId: 'ctx_old_dev',
        report: { ...report, outcome: 'succeeded' },
        released: true
      },
      {
        ...step,
        nodeId: 'test',
        startRequestId: createUuidV4(),
        releaseRequestId: createUuidV4(),
        taskId: 'task_old_test',
        dispatchId: 'ctx_old_test',
        report,
        released: true
      }
    )
    await runtime.startStep(state, step, node)
    const retry = call.mock.calls[1][1]
    expect(initial.workflowContext).toMatchObject({ nodeId: 'develop' })
    expect(retry.workflowContext).toMatchObject({
      nodeId: 'develop',
      previousDispatch: 'ctx_old_dev'
    })
    expect(retry.workflowContext.continuation).toContain('Actual QA failure')
    expect(retry.workflowContext.continuation).toContain(
      JSON.stringify({
        runId: 'run_fixture',
        fromNodeId: 'test',
        fromTaskId: 'task_old_test',
        fromDispatchId: 'ctx_old_test',
        reportMessageId: 'msg_qa',
        toNodeId: 'develop',
        toStartRequestId: step.startRequestId
      })
    )
    expect(retry.workflowContext.continuation).not.toContain('Stable developer instructions')
    const boundary = 'Current visit (changes between executions):'
    expect(initial.spec.split(boundary)[0]).toBe(retry.spec.split(boundary)[0])
    expect(initial.spec.indexOf('Stable developer instructions')).toBeLessThan(
      initial.spec.indexOf(boundary)
    )
  })

  it.each(['codex', 'dsh', 'zcode'])(
    'refuses %s overrides before an older transport can ignore them',
    async (agent) => {
      const definition = workflowDefinitionSchema.parse({
        version: 2,
        name: 'Node options',
        entry: 'agent',
        maxSteps: 2,
        nodes: [
          {
            id: 'agent',
            type: 'agent',
            agent,
            prompt: 'Task',
            launch: { model: 'custom-model' },
            onSuccess: 'done',
            onFailure: 'done'
          },
          { id: 'done', type: 'end', outcome: 'succeeded' }
        ]
      })
      const state = createWorkflowExecution(
        definition,
        'Input',
        { from: 'term_coord', worktree: 'folder:fixture', target: 'local' },
        'runtime'
      )
      state.runId = 'run_fixture'
      const call = vi.fn()
      const runtime = createOrchestrationWorkflowRuntime({
        runtimeId: 'runtime',
        call,
        assertCurrent: () => {},
        devMode: true,
        error: (code, message) => new Error(`${code}: ${message}`)
      })
      await expect(advanceWorkflow(state, runtime, async () => {})).rejects.toThrow(
        'incompatible_runtime'
      )
      expect(call).not.toHaveBeenCalled()
    }
  )
})
