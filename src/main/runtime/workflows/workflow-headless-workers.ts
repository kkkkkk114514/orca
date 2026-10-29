import { startWorkflowHeadlessWorker } from './workflow-headless-start'
import {
  interruptWorkflowHeadlessWorker,
  resumeWorkflowHeadlessWorker
} from './workflow-headless-controls'
import {
  WorkflowHeadlessReceipts,
  type SavedHeadlessWorker as SavedWorker
} from './workflow-headless-receipts'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { WorkerStartMutation } from '../rpc/methods/orchestration/worker/worker-start-mutation'
import { requireWorkerAuthority } from '../rpc/methods/orchestration/worker/worker-topology'
import { isWorkflowHeadlessWorkerStartOptions } from './workflow-headless-worker-launch'
import type { WorkflowHeadlessReport } from './workflow-headless-command'
import type { WorkflowResolvedConversation } from '../../../shared/workflow-node-conversation'

export class WorkflowHeadlessWorkers {
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>()
  private disposed = false
  private readonly receipts: WorkflowHeadlessReceipts

  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly root: string,
    private readonly call: (method: string, params: unknown, requestId?: string) => Promise<unknown>
  ) {
    this.receipts = new WorkflowHeadlessReceipts(root)
  }

  start(
    input: unknown,
    mutation?: WorkerStartMutation,
    reportRoot?: string,
    source?: WorkflowResolvedConversation
  ) {
    return startWorkflowHeadlessWorker(
      { ...this.controlDependencies(), isDisposed: () => this.disposed },
      input,
      mutation,
      reportRoot,
      source
    )
  }

  private assertAuthority(saved: SavedWorker) {
    const resource = this.runtime
      .getOrchestrationDb()
      .getWorkerTerminalResourceByOwner(saved.dispatchId)
    const authority = requireWorkerAuthority(this.runtime, saved.handle)
    if (
      resource?.ownership_state !== 'owned' ||
      authority.paneKey !== saved.paneKey ||
      authority.processIncarnation !== saved.processIncarnation
    ) {
      this.active.get(saved.dispatchId)?.abort.abort()
      throw new Error('Headless worker terminal authority changed; automatic settlement is fenced.')
    }
    return resource
  }

  private controlDependencies() {
    return {
      runtime: this.runtime,
      root: this.root,
      receipts: this.receipts,
      active: this.active,
      assertAuthority: (saved: SavedWorker) => this.assertAuthority(saved),
      settle: (saved: SavedWorker, report: WorkflowHeadlessReport) => this.settle(saved, report)
    }
  }

  interrupt(dispatchId: string) {
    return interruptWorkflowHeadlessWorker(this.controlDependencies(), dispatchId)
  }

  async canControl(dispatchId: string) {
    const saved = await this.receipts.read(dispatchId)
    return Boolean(saved.restart && saved.binding && !saved.report)
  }

  resume(dispatchId: string, text: string) {
    if (this.disposed) {
      throw new Error('Workflow host is shutting down.')
    }
    return resumeWorkflowHeadlessWorker(this.controlDependencies(), dispatchId, text)
  }

  private async settle(saved: SavedWorker, report: WorkflowHeadlessReport) {
    const resource = this.assertAuthority(saved)
    this.runtime.getOrchestrationDb().storeWorkerTerminalArchive({
      dispatchId: saved.dispatchId,
      resourceId: resource.id,
      kind: 'terminal_tail',
      content: JSON.stringify({
        lines: [report.body],
        truncated: false,
        terminalStatus: 'exited',
        warnings: ['Headless final report; no interactive terminal output.']
      })
    })
    await this.call(
      'orchestration.send',
      {
        from: saved.handle,
        to: saved.coordinator,
        type: 'worker_done',
        subject: `Headless workflow: ${report.outcome}`,
        body: report.body,
        payload: JSON.stringify({
          taskId: saved.taskId,
          dispatchId: saved.dispatchId,
          outcome: report.outcome,
          reportPath: this.receipts.path(saved.dispatchId),
          filesModified: report.filesModified
        })
      },
      saved.settlementRequestId
    )
    const dispatch = this.runtime.getOrchestrationDb().getDispatchContextById(saved.dispatchId)
    if (dispatch?.status !== (report.outcome === 'succeeded' ? 'completed' : 'failed')) {
      throw new Error('Orca did not accept the headless completion report.')
    }
    saved.status = 'settled'
    this.receipts.save(saved)
  }

  async telemetry(dispatches: readonly string[]) {
    return this.receipts.telemetry(
      dispatches.filter((dispatch) => {
        const worker = this.runtime.getOrchestrationDb().getWorkerDispatch(dispatch)
        return worker && isWorkflowHeadlessWorkerStartOptions(JSON.parse(worker.start_options))
      })
    )
  }

  activity = (ids: readonly string[]) =>
    this.receipts.activity(ids, this.active.has.bind(this.active))

  async inspect(dispatchId: string) {
    const worker = this.runtime.getOrchestrationDb().getWorkerDispatch(dispatchId)
    if (!worker || !isWorkflowHeadlessWorkerStartOptions(JSON.parse(worker.start_options))) {
      return
    }
    const saved = await this.receipts.read(dispatchId)
    const dispatch = this.runtime.getOrchestrationDb().getDispatchContextById(dispatchId)
    const reported = dispatch && ['completed', 'failed'].includes(dispatch.status)
    if (reported || saved.status === 'settled') {
      await this.active.get(dispatchId)?.done
      return
    }
    this.assertAuthority(saved)
    if (saved.status === 'report' && saved.report) {
      await this.settle(saved, saved.report)
      return
    }
    if (saved.status === 'error') {
      throw new Error(saved.error ?? 'Headless execution failed.')
    }
    if (!this.active.has(dispatchId)) {
      const latest = await this.receipts.read(dispatchId)
      const current = this.runtime.getOrchestrationDb().getDispatchContextById(dispatchId)
      if (
        latest.status === 'settled' ||
        (current && ['completed', 'failed'].includes(current.status))
      ) {
        return
      }
      if (latest.status === 'error') {
        throw new Error(latest.error ?? 'Headless execution failed.')
      }
      if (latest.status === 'report' && latest.report) {
        await this.settle(latest, latest.report)
        return
      }
      throw new Error(
        'The host restarted while a headless worker was running. Inspect its output and worker dispatch before recovery; the model will not be launched twice.'
      )
    }
  }

  async dispose() {
    this.disposed = true
    for (const { abort } of this.active.values()) {
      abort.abort()
    }
    await Promise.allSettled([...this.active.values()].map(({ done }) => done))
  }
}
