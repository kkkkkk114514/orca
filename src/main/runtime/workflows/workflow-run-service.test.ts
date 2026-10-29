import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowRunService } from './workflow-run-service'
import { workflowDefinitionSchema } from '../../../shared/workflow-definition'
import type { WorkflowRuntime } from '../../../shared/workflow-executor'
import type { WorkflowStepReport } from '../../../shared/workflow-execution'
import { workflowReportRecordSchema, type WorkflowReportRecord } from './workflow-report-record'
import { workflowReportPaths, workflowRunPaths } from './workflow-report-paths'
import { withWorkflowCheckpoint } from '../../../shared/node-workflow-checkpoint'
import type { WorkflowNodeConversations } from '../../../shared/workflow-node-conversation'

const roots: string[] = []
const services: WorkflowRunService[] = []
const waitForWorkflow = (assertion: () => unknown) => vi.waitFor(assertion, { timeout: 10_000 })
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const definition = workflowDefinitionSchema.parse({
  version: 1,
  name: 'Development and rework',
  entry: 'develop',
  maxSteps: 8,
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

async function fixture(dispatchPrefix = 'dispatch_') {
  const root = await mkdtemp(join(tmpdir(), 'workflow-host-'))
  roots.push(root)
  const reports = new Map<string, WorkflowStepReport>()
  const starts: { nodeId: string; requestId: string; dispatchId: string }[] = []
  let automaticallyComplete = false
  let simulateLostResponse = false
  const createCoordinator = vi.fn(async () => 'term_coordinator')
  const conversations: WorkflowNodeConversations = {}
  const resolveConversations = vi.fn(async () => ({ ...conversations }))
  const interruptWorker = vi.fn(async () => {})
  const resumeWorker = vi.fn(async () => {})
  const runtime: WorkflowRuntime = {
    runtimeId: 'runtime',
    async createRun() {
      return 'run_actual'
    },
    async startStep(_state, step, node) {
      const dispatchId = `${dispatchPrefix}${starts.length + 1}`
      starts.push({ nodeId: node.id, requestId: step.startRequestId, dispatchId })
      if (simulateLostResponse) {
        simulateLostResponse = false
        throw new Error('Connection lost after mutation')
      }
      return { taskId: `task_${starts.length}`, dispatchId }
    },
    async inspectStep(_state, step) {
      const report = reports.get(step.dispatchId ?? '')
      if (report) {
        return { report }
      }
      if (!automaticallyComplete) {
        return { waiting: 'Awaiting accepted completion' }
      }
      return {
        report: {
          outcome: step.nodeId === 'test' && starts.length === 2 ? 'failed' : 'succeeded',
          messageId: `message_${starts.length}`,
          body: `Verified ${step.nodeId}`,
          filesModified: ['code.ts']
        }
      }
    },
    async releaseStep() {
      return true
    }
  }
  const make = () => {
    const service = new WorkflowRunService({
      root,
      runtimeId: 'runtime',
      resolveConversations,
      createCoordinator,
      createRuntime: () => runtime,
      interruptWorker,
      resumeWorker,
      readConversation: async (_execution, step, before) => ({
        entries: [
          {
            id: step.dispatchId ?? '',
            role: 'activity',
            text: `records before ${before ?? 'tail'}`
          }
        ],
        source: 'journal',
        before: 0,
        hasMore: false,
        limited: false
      }),
      wait: (signal) => setTimeout(5, undefined, { signal })
    })
    services.push(service)
    return service
  }
  const service = make()
  const request = {
    id: randomUUID(),
    worktree: 'id:folder:non-git',
    definition,
    input: 'Implement the task'
  }
  return {
    service,
    root,
    request,
    reports,
    starts,
    createCoordinator,
    conversations,
    resolveConversations,
    interruptWorker,
    resumeWorker,
    make,
    completeAutomatically: () => {
      automaticallyComplete = true
    },
    loseStartResponse: () => {
      simulateLostResponse = true
    }
  }
}

describe('host-owned workflow execution', () => {
  it('pauses the whole run, durably queues supplements, and resumes the same dispatch exactly once', async () => {
    const f = await fixture('ctx_')
    await f.service.start('desktop', f.request)
    await waitForWorkflow(() => expect(f.starts).toHaveLength(1))
    const control = {
      id: f.request.id,
      nodeId: 'develop',
      dispatchId: 'ctx_1',
      requestId: randomUUID(),
      action: 'message' as const,
      text: 'Preserve the keyboard controls'
    }
    await expect(f.service.control('other', control)).rejects.toThrow()
    await expect(f.service.control('desktop', { ...control, nodeId: 'test' })).rejects.toThrow(
      'current unfinished'
    )
    expect((await f.service.control('desktop', control)).phase).toBe('paused')
    await f.service.control('desktop', control)
    expect(f.interruptWorker).toHaveBeenCalledTimes(1)
    expect(f.starts).toHaveLength(1)
    expect((await f.service.session('desktop', control)).control).toEqual({
      paused: true,
      pendingMessages: [{ id: control.requestId, text: control.text }]
    })
    const restarted = f.make()
    await restarted.resume('desktop', f.request.id)
    await restarted.resume('desktop', f.request.id)
    expect(f.resumeWorker).toHaveBeenCalledTimes(1)
    expect(f.resumeWorker.mock.calls[0]).toMatchObject([{}, { dispatchId: 'ctx_1' }, control.text])
    expect(f.starts).toHaveLength(1)
    f.completeAutomatically()
    await waitForWorkflow(async () =>
      expect((await restarted.show('desktop', f.request.id)).phase).toBe('succeeded')
    )
    expect(f.starts.map((step) => step.nodeId)).toEqual(['develop', 'test', 'develop', 'test'])
    await expect(
      restarted.control('desktop', { ...control, requestId: randomUUID() })
    ).rejects.toThrow('current unfinished')
  })

  it('fences scheduling immediately when an externally interrupted worker reports its stop', async () => {
    const f = await fixture('ctx_')
    await f.service.start('desktop', f.request)
    await waitForWorkflow(() => expect(f.starts).toHaveLength(1))
    f.service.workerInterrupted((step) => step.dispatchId === 'ctx_1')
    f.completeAutomatically()
    await waitForWorkflow(() => expect(f.interruptWorker).toHaveBeenCalledTimes(1))
    expect((await f.service.show('desktop', f.request.id)).phase).toBe('paused')
    expect(f.starts).toHaveLength(1)
  })

  it('pins independent node selections and permits changed roles without a previous-run claim', async () => {
    const f = await fixture()
    const request = { ...f.request, workflowId: randomUUID() }
    await f.service.start('desktop', request)
    f.completeAutomatically()
    await waitForWorkflow(async () =>
      expect((await f.service.show('desktop', request.id)).phase).toBe('succeeded')
    )
    const next = {
      ...request,
      id: randomUUID(),
      input: 'Next task',
      definition: {
        ...definition,
        nodes: definition.nodes.map((node) =>
          node.type === 'agent' ? { ...node, prompt: 'Changed role' } : node
        )
      }
    }
    f.conversations.develop = {
      key: 'a'.repeat(64),
      workspaceId: 'folder:non-git',
      agent: 'dsh',
      sessionId: 'chosen-history'
    }
    await f.service.start('desktop', next)
    expect(f.resolveConversations).toHaveBeenCalledWith('desktop', next)
    const saved = JSON.parse(
      await readFile(workflowRunPaths(f.root, 'desktop', next.id).metadata, 'utf8')
    )
    expect(saved.conversations.develop.sessionId).toBe('chosen-history')
    const starts = await Promise.allSettled([
      f.service.start('desktop', { ...next, id: randomUUID() }),
      f.service.start('desktop', { ...next, id: randomUUID() })
    ])
    expect(starts.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
  })

  it('previews only indexed artifacts and protects running workflows, reports and other owners', async () => {
    const f = await fixture()
    await f.service.start('desktop', f.request)
    await waitForWorkflow(async () => expect(f.starts).toHaveLength(1))
    const root = workflowRunPaths(f.root, 'desktop', f.request.id).directory
    const artifact = join(
      workflowReportPaths(root, 'develop', 'dispatch_1').artifacts,
      'capture.png'
    )
    await mkdir(dirname(artifact), { recursive: true })
    await writeFile(artifact, 'screenshot')
    const params = { id: f.request.id, category: 'artifacts' as const }
    const active = await f.service.storage('desktop', params)
    expect(active).toMatchObject({ files: 1, bytes: 10, canClear: false })
    await expect(
      f.service.storage('desktop', { ...params, confirmation: active.confirmation })
    ).rejects.toThrow()
    await expect(f.service.storage('other', params)).rejects.toThrow()
    f.completeAutomatically()
    await waitForWorkflow(async () =>
      expect((await f.service.show('desktop', f.request.id)).phase).toBe('succeeded')
    )
    const plan = await f.service.storage('desktop', params)
    await writeFile(artifact, 'changed')
    await expect(
      f.service.storage('desktop', { ...params, confirmation: plan.confirmation })
    ).rejects.toThrow('preview')
    const changed = await f.service.storage('desktop', params)
    expect(
      await f.service.storage('desktop', { ...params, confirmation: changed.confirmation })
    ).toMatchObject({ deleted: 1, errors: [] })
    expect((await f.service.storage('desktop', params)).files).toBe(0)
    expect((await f.service.show('desktop', f.request.id)).phase).toBe('succeeded')
    expect(
      await readFile(workflowReportPaths(root, 'develop', 'dispatch_1').report, 'utf8')
    ).toContain('Verified develop')
    expect(await readFile(join(root, 'execution.json'), 'utf8')).toContain('succeeded')
  })

  it('reads only the authenticated run and node visits without dispatching another worker', async () => {
    const f = await fixture('ctx_')
    await f.service.start('desktop', f.request)
    await waitForWorkflow(async () =>
      expect((await f.service.show('desktop', f.request.id)).execution?.steps[0]?.dispatchId).toBe(
        'ctx_1'
      )
    )
    const params = { id: f.request.id, nodeId: 'develop' }
    const page = await f.service.session('desktop', params)
    expect(page).toMatchObject({
      workspaceId: 'folder:non-git',
      agent: 'dsh',
      dispatchId: 'ctx_1',
      task: f.request.input,
      instructions: 'Develop',
      source: 'journal'
    })
    expect(page.visits).toEqual([{ dispatchId: 'ctx_1', outcome: 'running' }])
    expect(f.starts).toHaveLength(1)
    expect(f.createCoordinator).toHaveBeenCalledTimes(1)
    await expect(f.service.session('other-client', params)).rejects.toThrow()
    await expect(f.service.session('desktop', { ...params, nodeId: 'test' })).rejects.toThrow(
      'no matching'
    )
    await expect(
      f.service.session('desktop', { ...params, dispatchId: 'ctx_other' })
    ).rejects.toThrow('no matching')
    await expect(
      f.service.session('desktop', { ...params, nodeId: '../develop' })
    ).rejects.toThrow()
    f.completeAutomatically()
    await waitForWorkflow(async () =>
      expect((await f.service.show('desktop', f.request.id)).phase).toBe('succeeded')
    )
    const historical = await f.service.session('desktop', {
      ...params,
      dispatchId: 'ctx_1',
      before: 42
    })
    expect(historical.entries[0]?.text).toBe('records before 42')
    expect(historical.report).toBe('Verified develop')
    expect(historical.visits).toHaveLength(2)
    await expect(f.service.session('desktop', { ...params, dispatchId: 'ctx_2' })).rejects.toThrow(
      'no matching'
    )
  })

  it('joins repeated start intent, fences changed input and namespaces callers', async () => {
    const f = await fixture()
    await Promise.all([
      f.service.start('desktop', f.request),
      f.service.start('desktop', f.request)
    ])
    await waitForWorkflow(() => expect(f.starts).toHaveLength(1))
    expect(f.createCoordinator).toHaveBeenCalledTimes(1)
    await expect(
      f.service.start('desktop', { ...f.request, input: 'Different task' })
    ).rejects.toThrow('different input')
    await expect(f.service.show('another-device', f.request.id)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(f.service.show('desktop', '../another-run')).rejects.toThrow()
    expect((await f.service.show('desktop', f.request.id)).phase).not.toBe('attention')
  })

  it('executes development, failed test, rework and passing test without a renderer', async () => {
    const f = await fixture()
    f.completeAutomatically()
    await f.service.start('desktop', f.request)
    await waitForWorkflow(async () =>
      expect((await f.service.show('desktop', f.request.id)).phase).toBe('succeeded')
    )
    expect(f.starts.map((step) => step.nodeId)).toEqual(['develop', 'test', 'develop', 'test'])
    const state = (await f.service.show('desktop', f.request.id)).execution
    expect(state?.steps.map((step) => step.report?.outcome)).toEqual([
      'succeeded',
      'failed',
      'succeeded',
      'succeeded'
    ])
    expect(state?.steps.every((step) => step.released)).toBe(true)
    if (!state) {
      throw new Error('Missing saved execution')
    }
    const records: WorkflowReportRecord[] = []
    for (const step of state.steps) {
      if (!step.report?.reportPath) {
        throw new Error('Missing organized report path')
      }
      const record = workflowReportRecordSchema.parse(
        JSON.parse(await readFile(step.report.reportPath, 'utf8'))
      )
      expect(record.report).toEqual(step.report)
      expect(record.workflowId).toBe(f.request.id)
      expect(record.workspace).toBe(f.request.worktree)
      expect(record.dispatchId).toBe(step.dispatchId)
      expect(await readFile(join(dirname(step.report.reportPath), 'report.md'), 'utf8')).toContain(
        step.report.body
      )
      expect((await stat(join(dirname(step.report.reportPath), 'artifacts'))).isDirectory()).toBe(
        true
      )
      records.push(record)
    }
    expect(new Set(state.steps.map((step) => step.report?.reportPath)).size).toBe(4)
    expect(records.map((record) => record.visit)).toEqual([1, 1, 2, 2])
    expect(records[0].source).toBeUndefined()
    for (let index = 0; index < records.length - 1; index++) {
      const source = records[index]
      const target = records[index + 1]
      expect(source.route.dispatchedTo).toEqual({
        nodeId: target.nodeId,
        taskId: target.taskId,
        dispatchId: target.dispatchId
      })
      expect(target.source).toEqual({
        nodeId: source.nodeId,
        taskId: source.taskId,
        dispatchId: source.dispatchId,
        messageId: source.report.messageId,
        reportPath: source.report.reportPath
      })
    }
    expect(records.at(-1)?.route).toEqual({ nextNodeId: 'done', targetType: 'end' })
  })

  it('pauses scheduling and resumes a known worker from disk after the service restarts', async () => {
    const f = await fixture()
    await f.service.start('desktop', f.request)
    await waitForWorkflow(async () =>
      expect((await f.service.show('desktop', f.request.id)).waiting).toContain('Awaiting')
    )
    await f.service.pause('desktop', f.request.id)
    await f.service.dispose()
    f.completeAutomatically()
    const restored = f.make()
    expect((await restored.show('desktop', f.request.id)).phase).toBe('paused')
    await restored.resume('desktop', f.request.id)
    await waitForWorkflow(async () =>
      expect((await restored.show('desktop', f.request.id)).phase).toBe('succeeded')
    )
    expect(f.starts.filter((step) => step.nodeId === 'develop')).toHaveLength(2)
    expect(f.createCoordinator).toHaveBeenCalledTimes(1)
    expect(new Set(f.starts.map((step) => step.dispatchId)).size).toBe(f.starts.length)
  })

  it('keeps the saved mutation ID after an uncertain start and resumes it explicitly', async () => {
    const f = await fixture()
    f.loseStartResponse()
    await f.service.start('desktop', f.request)
    await waitForWorkflow(async () =>
      expect((await f.service.show('desktop', f.request.id)).phase).toBe('attention')
    )
    const uncertain = f.starts[0].requestId
    f.completeAutomatically()
    await f.service.resume('desktop', f.request.id)
    await waitForWorkflow(async () =>
      expect((await f.service.show('desktop', f.request.id)).phase).toBe('succeeded')
    )
    expect(f.starts[1].requestId).toBe(uncertain)
  })

  it('backfills legacy reports on resume without running completed nodes again', async () => {
    const f = await fixture()
    f.completeAutomatically()
    await f.service.start('desktop', f.request)
    await waitForWorkflow(async () =>
      expect((await f.service.show('desktop', f.request.id)).phase).toBe('succeeded')
    )
    await f.service.dispose()
    const paths = workflowRunPaths(f.root, 'desktop', f.request.id)
    await withWorkflowCheckpoint(paths.checkpoint, false, async (store) => {
      const state = await store.read()
      for (const step of state.steps) {
        if (step.report) {
          step.report.reportPath = `legacy-${step.dispatchId}.json`
        }
      }
      await store.save(state)
    })
    await rm(join(paths.directory, 'reports'), { recursive: true, force: true })
    const restored = f.make()
    const old = await restored.show('desktop', f.request.id)
    expect(old.execution?.steps[0].report?.reportPath).toContain('legacy-')
    await expect(stat(join(paths.directory, 'reports'))).rejects.toMatchObject({ code: 'ENOENT' })
    await restored.resume('desktop', f.request.id)
    await waitForWorkflow(async () => {
      const state = (await restored.show('desktop', f.request.id)).execution
      expect(state?.steps[0].report?.reportPath).toContain('report.json')
    })
    await restored.dispose()
    const first = workflowReportPaths(paths.directory, 'develop', 'dispatch_1')
    const report = workflowReportRecordSchema.parse(
      JSON.parse(await readFile(first.report, 'utf8'))
    )
    expect(report.sourceReportPath).toBe('legacy-dispatch_1.json')
    expect(f.starts).toHaveLength(4)
    await writeFile(first.markdown, 'stale derived view')
    const restarted = f.make()
    await restarted.resume('desktop', f.request.id)
    await waitForWorkflow(async () =>
      expect(await readFile(first.markdown, 'utf8')).toContain(report.report.body)
    )
    expect(f.starts).toHaveLength(4)
    expect(await readFile(first.report, 'utf8')).not.toContain('stale derived view')
  })

  it('stops before the next node on an archive failure and recovers the accepted report', async () => {
    const f = await fixture()
    await f.service.start('desktop', f.request)
    await waitForWorkflow(async () =>
      expect((await f.service.show('desktop', f.request.id)).waiting).toContain('Awaiting')
    )
    const root = workflowRunPaths(f.root, 'desktop', f.request.id).directory
    const report = workflowReportPaths(root, 'develop', 'dispatch_1')
    await mkdir(report.report)
    f.reports.set('dispatch_1', {
      outcome: 'succeeded',
      messageId: 'accepted_before_io_failure',
      body: 'Actual accepted report',
      filesModified: []
    })
    await waitForWorkflow(async () =>
      expect((await f.service.show('desktop', f.request.id)).phase).toBe('attention')
    )
    expect(f.starts).toHaveLength(1)
    await rm(report.report, { recursive: true })
    f.completeAutomatically()
    await f.service.resume('desktop', f.request.id)
    await waitForWorkflow(async () =>
      expect((await f.service.show('desktop', f.request.id)).phase).toBe('succeeded')
    )
    const saved = workflowReportRecordSchema.parse(
      JSON.parse(await readFile(report.report, 'utf8'))
    )
    expect(saved.report.messageId).toBe('accepted_before_io_failure')
    expect(f.starts.map((step) => step.nodeId)).toEqual(['develop', 'test', 'develop', 'test'])
  })

  it('surfaces an archive identity conflict without overwriting an accepted report', async () => {
    const f = await fixture()
    f.completeAutomatically()
    await f.service.start('desktop', f.request)
    await waitForWorkflow(async () =>
      expect((await f.service.show('desktop', f.request.id)).phase).toBe('succeeded')
    )
    await f.service.dispose()
    const root = workflowRunPaths(f.root, 'desktop', f.request.id).directory
    const path = workflowReportPaths(root, 'develop', 'dispatch_1').report
    const original = await readFile(path, 'utf8')
    const modified = workflowReportRecordSchema.parse(JSON.parse(original))
    modified.report.body = 'Unaccepted edited content'
    await writeFile(path, JSON.stringify(modified))
    const restored = f.make()
    await restored.resume('desktop', f.request.id)
    await waitForWorkflow(async () =>
      expect((await restored.show('desktop', f.request.id)).phase).toBe('attention')
    )
    expect((await restored.show('desktop', f.request.id)).error).toContain(
      'accepted content changed'
    )
    expect(await readFile(path, 'utf8')).toContain('Unaccepted edited content')
    expect(f.starts).toHaveLength(4)
    await writeFile(path, original)
    await restored.resume('desktop', f.request.id)
    await waitForWorkflow(async () => {
      const snapshot = await restored.show('desktop', f.request.id)
      expect(snapshot.phase).toBe('succeeded')
      expect(snapshot.error).toBeUndefined()
    })
    expect(f.starts).toHaveLength(4)
  })
})
