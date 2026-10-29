import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { RuntimeClient, type RuntimeRpcSuccess } from '../../src/cli/runtime-client'
import { createWorkflowRuntime } from '../../src/cli/workflow-runtime'
import { createWorkflowExecution } from '../../src/shared/workflow-executor'
import { workflowDefinitionSchema } from '../../src/shared/workflow-definition'
import { createRootDispatch } from '../../src/main/runtime/orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../../src/main/runtime/rpc/methods/orchestration/rpc-test-harness'
import { getAppEnvironment, setAppEnvironment } from '../../src/shared/app-environment'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKFLOW_RUN_METHODS } from '../../src/main/runtime/rpc/methods/workflow-runs'
import { eraseRpcMethods } from '../../src/main/runtime/rpc/core'
import { getWorkflowRunService } from '../../src/main/runtime/workflows/workflow-host-runtime'

describe('workflow runtime completion boundary', () => {
  const harness = createOrchestrationRpcHarness()
  afterEach(() => {
    harness.cleanup()
    vi.restoreAllMocks()
  })

  function setup() {
    const { db, runtime, ctx, activeRunId } = harness.setup()
    if (!activeRunId) {
      throw new Error('Missing test Run')
    }
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker' ? 'tab_worker:leaf_worker' : harness.coordinatorPaneKey
    )
    vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
    const task = db.createTask({ spec: 'Execute actual assertions' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker', 'tab_worker:leaf_worker')
    const client = new RuntimeClient('unused-test-profile', 60_000, null, null)
    vi.spyOn(client, 'call').mockImplementation(async <T>(method: string, params?: unknown) => {
      const result = await harness.call(
        method,
        z.record(z.string(), z.unknown()).parse(params),
        ctx
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: real RPC methods produce this payload; the adapter validates its unknown result.
      return {
        id: 'test-rpc',
        ok: true,
        result,
        _meta: { runtimeId: 'runtime' }
      } as RuntimeRpcSuccess<T>
    })
    const adapter = createWorkflowRuntime(client, 'runtime', () => {})
    const state = createWorkflowExecution(
      workflowDefinitionSchema.parse({
        version: 1,
        name: 'One step',
        entry: 'work',
        maxSteps: 1,
        nodes: [
          {
            id: 'work',
            type: 'agent',
            agent: 'dsh',
            prompt: 'Work',
            onSuccess: 'done',
            onFailure: 'failed'
          },
          { id: 'done', type: 'end', outcome: 'succeeded' },
          { id: 'failed', type: 'end', outcome: 'failed' }
        ]
      }),
      'Task',
      { worktree: 'folder:fixture', from: 'term_coord', target: 'target' },
      'runtime'
    )
    state.runId = activeRunId
    const step = {
      nodeId: 'work',
      taskId: task.id,
      dispatchId: dispatch.id,
      startRequestId: crypto.randomUUID(),
      startRuntimeId: 'runtime',
      releaseRequestId: crypto.randomUUID(),
      released: false
    }
    state.steps.push(step)
    return { db, ctx, task, dispatch, adapter, state, step }
  }

  it.each(['succeeded', 'failed'] as const)(
    'accepts %s only from the real worker-report settlement path',
    async (outcome) => {
      const f = setup()
      expect(await f.adapter.inspectStep(f.state, f.step)).toHaveProperty('waiting')
      await harness.call(
        'orchestration.send',
        {
          from: 'term_worker',
          to: 'term_coord',
          subject: 'QA result',
          body: 'revision abc: node --test; assertion result',
          type: 'worker_done',
          payload: JSON.stringify({
            taskId: f.task.id,
            dispatchId: f.dispatch.id,
            outcome,
            reportPath: '/host/reports/qa.json',
            filesModified: ['average.mjs']
          })
        },
        f.ctx
      )
      expect(await f.adapter.inspectStep(f.state, f.step)).toMatchObject({
        report: {
          outcome,
          body: 'revision abc: node --test; assertion result',
          reportPath: '/host/reports/qa.json',
          filesModified: ['average.mjs']
        }
      })
      expect(f.db.getTask(f.task.id)?.status).toBe(outcome === 'succeeded' ? 'completed' : 'failed')
    }
  )

  it('does not turn an operator-marked failed task into a business completion', async () => {
    const f = setup()
    await harness.call(
      'orchestration.taskUpdate',
      {
        id: f.task.id,
        status: 'failed',
        result: 'Startup permission failure'
      },
      f.ctx
    )
    expect(await f.adapter.inspectStep(f.state, f.step)).toHaveProperty('waiting')
  })

  it('fences a checkpoint that names another task or Run', async () => {
    const f = setup()
    f.state.runId = 'another-run'
    await expect(f.adapter.inspectStep(f.state, f.step)).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
  })

  it('starts a canvas run through the real host adapter, records a durable Run and isolates callers', async () => {
    const originalEnvironment = getAppEnvironment()
    const root = await mkdtemp(join(tmpdir(), 'workflow-rpc-'))
    setAppEnvironment({
      ...originalEnvironment,
      getPath: (name) => (name === 'userData' ? root : originalEnvironment.getPath(name)),
      onWillQuit: () => {}
    })
    const { runtime, db } = harness.setup(false)
    const git = { path: root, head: '', branch: '', isBare: false, isMainWorktree: false }
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      ...git,
      id: 'folder:fixture',
      repoId: 'folder-project',
      displayName: 'Folder fixture',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git,
      linkedItems: []
    })
    vi.spyOn(runtime, 'dedupeTerminalCreate').mockResolvedValue({
      handle: 'term_coord',
      ptyId: 'coordinator-pty',
      worktreeId: 'folder:fixture',
      title: 'Coordinator',
      surface: 'background'
    })
    const methods = eraseRpcMethods(WORKFLOW_RUN_METHODS)
    const call = async (name: string, params: unknown, deviceId?: string) => {
      const method = methods.find((candidate) => candidate.name === name)
      if (!method) {
        throw new Error('Missing workflow method')
      }
      return method.handler(method.params?.parse(params), {
        runtime,
        caller: deviceId ? { kind: 'paired-device', deviceId } : { kind: 'desktop' }
      })
    }
    const id = crypto.randomUUID()
    try {
      await call('workflow.start', {
        id,
        worktree: 'id:folder:fixture',
        input: 'No model invocation',
        definition: {
          version: 1,
          name: 'Canvas end smoke',
          entry: 'done',
          maxSteps: 1,
          nodes: [{ id: 'done', type: 'end', outcome: 'succeeded' }]
        }
      })
      await vi.waitFor(async () => {
        expect(await call('workflow.show', { id })).toMatchObject({
          phase: 'succeeded',
          execution: { steps: [] }
        })
      })
      const snapshot = z
        .object({ execution: z.object({ runId: z.string(), runRequestId: z.string() }) })
        .parse(await call('workflow.show', { id }))
      expect(db.getRun(snapshot.execution.runId)?.objective).toBe('Workflow: Canvas end smoke')
      expect(
        db.getMutationReceipt(
          db.getOrCreateLocalMutationCallerFingerprint(),
          snapshot.execution.runRequestId
        )?.state
      ).toBe('completed')
      await expect(call('workflow.show', { id }, 'another-device')).rejects.toMatchObject({
        code: 'ENOENT'
      })
      expect(runtime.dedupeTerminalCreate).toHaveBeenCalledTimes(1)
    } finally {
      await getWorkflowRunService(runtime).dispose()
      setAppEnvironment(originalEnvironment)
      await rm(root, { recursive: true, force: true })
    }
  })
})
