import { z } from 'zod'
import { createUuidV4 } from '../../../shared/uuid-v4'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { SavedHeadlessWorker, WorkflowHeadlessReceipts } from './workflow-headless-receipts'
import type { WorkflowHeadlessReport } from './workflow-headless-command'
import { prepareWorkflowHeadlessWorkerLaunch } from './workflow-headless-worker-launch'
import { executeWorkflowHeadlessInvocation } from './workflow-headless-invocation'
import { claimWorkflowConversation } from './workflow-conversation-lease'
import { WorkflowSessionJournal } from './workflow-session-journal'

export type WorkflowHeadlessControlDependencies = {
  runtime: OrcaRuntimeService
  root: string
  receipts: WorkflowHeadlessReceipts
  active: Map<string, { abort: AbortController; done: Promise<void> }>
  assertAuthority(saved: SavedHeadlessWorker): unknown
  settle(saved: SavedHeadlessWorker, report: WorkflowHeadlessReport): Promise<void>
}

export async function interruptWorkflowHeadlessWorker(
  d: WorkflowHeadlessControlDependencies,
  dispatchId: string
) {
  const saved = await d.receipts.read(dispatchId)
  d.assertAuthority(saved)
  const live = d.active.get(dispatchId)
  if (live) {
    // The invocation owns its mutable receipt until its process termination barrier completes.
    live.abort.abort('workflow-user-interrupt')
    await live.done
  }
  const latest = await d.receipts.read(dispatchId)
  if (latest.report) {
    throw new Error(
      'The node completed before interruption. Its accepted report is preserved; resume the workflow to proceed.'
    )
  }
  if (!latest.report) {
    if (latest.status !== 'paused') {
      throw new Error(latest.error ?? 'Workflow worker interruption could not be confirmed.')
    }
    if (live) {
      latest.interruptedDurationMs = latest.telemetry?.durationMs
    }
    latest.status = 'paused'
    latest.error = undefined
    d.receipts.save(latest)
  }
}

export async function resumeWorkflowHeadlessWorker(
  d: WorkflowHeadlessControlDependencies,
  dispatchId: string,
  text: string
) {
  const saved = await d.receipts.read(dispatchId)
  d.assertAuthority(saved)
  if (saved.report || saved.status === 'settled') {
    return
  }
  if (d.active.has(dispatchId)) {
    throw new Error('Workflow worker is still stopping.')
  }
  if (saved.status !== 'paused') {
    throw new Error(
      'The previous invocation has no confirmed interruption; inspect it before resuming.'
    )
  }
  const { restart, binding } = saved
  if (!restart || !binding) {
    throw new Error('This older worker has no resumable launch configuration.')
  }
  if (!saved.sessionId) {
    throw new Error(
      'The CLI was interrupted before it provided a session ID. Its conversation cannot be resumed safely.'
    )
  }
  const dispatch = d.runtime.getOrchestrationDb().getDispatchContextById(dispatchId)
  if (!dispatch || !['pending', 'dispatched'].includes(dispatch.status)) {
    throw new Error('The worker assignment is no longer active.')
  }
  const workspace = z
    .object({ id: z.string(), path: z.string(), connectionId: z.string().nullable() })
    .parse(await d.runtime.showTerminalWorkspaceLaunchScope(`id:${binding.workspaceId}`))
  const abort = new AbortController()
  const prepared = await prepareWorkflowHeadlessWorkerLaunch({
    runtime: d.runtime,
    workspace,
    params: restart.params,
    agent: binding.agent,
    spec: restart.params.spec ?? '',
    root: d.root,
    signal: abort.signal
  })
  let release: (() => Promise<void>) | undefined
  try {
    if (prepared.configurationKey !== binding.configurationKey) {
      throw new Error(
        'Node CLI configuration changed while paused. Restore its configuration before resuming.'
      )
    }
    release = await claimWorkflowConversation(d.root, {
      agent: binding.agent,
      sessionId: saved.sessionId
    })
    const command = prepared.invocationCommand(
      saved.sessionId,
      restart.artifacts,
      false,
      saved.codexHome,
      `The user interrupted this visit. Continue the unfinished work in this same conversation. Recheck any interrupted command before repeating it.\nUser supplements (JSON): ${JSON.stringify(text)}\nReturn the required final workflow report when finished.`
    )
    if (text) {
      new WorkflowSessionJournal(`${d.receipts.path(dispatchId)}.conversation.jsonl`).append(text, {
        id: `supplement:${createUuidV4()}`,
        role: 'user',
        timestamp: Date.now(),
        source: 'transcript',
        blocks: [{ type: 'text', text }]
      })
    }
    saved.status = 'running'
    saved.pauseRequested = false
    saved.error = undefined
    saved.telemetry = undefined
    d.receipts.save(saved)
    const done = executeWorkflowHeadlessInvocation({
      runtime: d.runtime,
      saved,
      agent: binding.agent,
      command,
      resumeSessionId: saved.sessionId,
      previousUsage: saved.sessionUsage,
      abort,
      receipts: d.receipts,
      assertAuthority: () => d.assertAuthority(saved),
      settle: (report) => d.settle(saved, report)
    }).finally(async () => {
      try {
        await Promise.all([prepared.cleanup(), release?.()])
      } finally {
        d.active.delete(dispatchId)
      }
    })
    d.active.set(dispatchId, { abort, done })
    void done.catch(() => {})
  } catch (error) {
    await Promise.all([prepared.cleanup(), release?.()])
    throw error
  }
}
