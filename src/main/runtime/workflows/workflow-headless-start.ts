import type { WorkflowHeadlessControlDependencies } from './workflow-headless-controls'
import { z } from 'zod'
import { createUuidV4 } from '../../../shared/uuid-v4'
import type { SavedHeadlessWorker as SavedWorker } from './workflow-headless-receipts'
import { WorkerStartParams } from '../../../shared/rpc-contract/orchestration-worker-start-params'
import type { WorkerStartMutation } from '../rpc/methods/orchestration/worker/worker-start-mutation'
import { requireWorkerAuthority } from '../rpc/methods/orchestration/worker/worker-topology'
import { prepareWorkflowHeadlessWorkerLaunch } from './workflow-headless-worker-launch'
import { resolveRunScope } from '../rpc/methods/orchestration/runs/run-scope'
import { resolveDispatchCreator } from '../rpc/methods/orchestration/runs/dispatch-creator'
import { isWorkflowHeadlessAgent } from './workflow-headless-command'
import { prepareWorkflowNodeSession } from './workflow-node-session'
import type { WorkflowResolvedConversation } from '../../../shared/workflow-node-conversation'
import { executeWorkflowHeadlessInvocation } from './workflow-headless-invocation'
import { prepareWorkflowReportArtifacts } from './workflow-report-paths'

export async function startWorkflowHeadlessWorker(
  d: WorkflowHeadlessControlDependencies & { isDisposed(): boolean },
  input: unknown,
  mutation?: WorkerStartMutation,
  reportRoot?: string,
  source?: WorkflowResolvedConversation
) {
  if (d.isDisposed()) {
    throw new Error('Workflow host is shutting down.')
  }
  const params = WorkerStartParams.parse(input)
  const agent = params.agent
  if (
    !isWorkflowHeadlessAgent(agent) ||
    !params.spec ||
    params.task ||
    params.terminal ||
    params.on
  ) {
    throw new Error(
      'Headless canvas workers require a new DSH, ZCode or Codex task in an existing host workspace.'
    )
  }
  const runtime = d.runtime
  const run = resolveRunScope(runtime, {
    runId: params.run,
    callerTerminalHandle: params.from,
    callerSession: undefined,
    requireCurrentConsumer: true
  })
  const workspace = z
    .object({ id: z.string(), path: z.string(), connectionId: z.string().nullable() })
    .parse(await runtime.showTerminalWorkspaceLaunchScope(params.worktree ?? 'current'))
  const abort = new AbortController()
  const prepared = await prepareWorkflowHeadlessWorkerLaunch({
    agent,
    params,
    runtime,
    workspace,
    spec: params.spec,
    root: d.root,
    signal: abort.signal
  })
  let releaseConversation: (() => Promise<void>) | undefined
  try {
    if (d.isDisposed()) {
      throw new Error('Workflow host shut down during node configuration.')
    }
    const { launch } = prepared
    const { binding, session, codexHome, release } = await prepareWorkflowNodeSession({
      runtime,
      receipts: d.receipts,
      root: d.root,
      runId: run.id,
      workspaceId: workspace.id,
      agent,
      configurationKey: prepared.configurationKey,
      coordinator: params.from,
      context: params.workflowContext,
      selected: source
    })
    releaseConversation = release
    const db = runtime.getOrchestrationDb()
    const started = db.createStartingWorkerDispatch({
      taskSpec: params.spec,
      taskTitle: params.taskTitle,
      taskRunId: run.id,
      taskCreatedByTerminalHandle: params.from,
      taskCreatedByPaneKey: runtime.getTerminalPaneKey(params.from) ?? undefined,
      taskCreatedByProcessIncarnation:
        runtime.getTerminalProcessIncarnation(params.from) ?? undefined,
      taskCreatedByRunGeneration: run.consumer_generation,
      startOptions: { execution: 'workflow_headless', agent, worktree: workspace.id, launch },
      runtimeEpoch: runtime.getRuntimeId(),
      mutationReceipt: mutation,
      creator: resolveDispatchCreator(runtime, params.from, undefined),
      maxDepth: runtime.getNestedWorkerMaxDepth()
    })
    const dispatchId = started.dispatch.id
    try {
      const artifacts = await prepareWorkflowReportArtifacts(
        reportRoot,
        params.workflowContext?.nodeId,
        dispatchId
      )
      const command = prepared.invocationCommand(
        session?.sessionId,
        artifacts,
        Boolean(source && !params.workflowContext?.previousDispatch),
        codexHome
      )
      const terminal = await runtime.createTerminal(`id:${workspace.id}`, {
        title: `${agent} headless · ${started.task.id}`,
        surfaceOwner: false
      })
      const authority = requireWorkerAuthority(runtime, terminal.handle)
      db.recordCreatedWorkerTerminalCustody({
        dispatchId,
        handle: terminal.handle,
        paneKey: authority.paneKey,
        processIncarnation: authority.processIncarnation,
        worktreeId: workspace.id,
        hostScope: authority.hostScope ?? null
      })
      const effects = [
        {
          kind: 'terminal',
          role: 'agent',
          action: 'created',
          id: terminal.handle,
          surface: 'background'
        }
      ]
      db.prepareStartingWorkerAuthority({
        dispatchId,
        handle: terminal.handle,
        ...authority,
        worktreeId: workspace.id,
        effects,
        setupState: 'not_applicable',
        terminalOwnership: 'created'
      })
      const saved: SavedWorker = {
        dispatchId,
        taskId: started.task.id,
        handle: terminal.handle,
        coordinator: params.from,
        paneKey: authority.paneKey,
        processIncarnation: authority.processIncarnation,
        settlementRequestId: createUuidV4(),
        binding,
        sessionId: session?.sessionId,
        codexHome: agent === 'codex' ? (command.env?.CODEX_HOME ?? null) : undefined,
        restart: { params, artifacts },
        status: 'running'
      }
      d.receipts.save(saved)
      db.markWorkerDispatchReady(dispatchId, effects)
      const done = executeWorkflowHeadlessInvocation({
        runtime,
        saved,
        agent,
        command,
        resumeSessionId: session?.sessionId,
        previousUsage: session?.usage,
        abort,
        receipts: d.receipts,
        assertAuthority: () => d.assertAuthority(saved),
        settle: (report) => d.settle(saved, report)
      }).finally(async () => {
        try {
          await Promise.all([prepared.cleanup(), releaseConversation?.()])
        } finally {
          d.active.delete(dispatchId)
        }
      })
      void done.catch(() => {})
      d.active.set(dispatchId, { abort, done })
      return {
        runId: run.id,
        taskId: started.task.id,
        dispatchId,
        state: 'ready',
        execution: 'headless'
      }
    } catch (error) {
      db.failWorkerStart(
        dispatchId,
        'headless_launch',
        'Headless worker setup failed; inspect the start receipt before retrying.'
      )
      throw error
    }
  } catch (error) {
    await Promise.all([releaseConversation?.(), prepared.cleanup()])
    throw error
  }
}
