import { runProcess } from '@orca/process-host'
import type { SavedHeadlessWorker, WorkflowHeadlessReceipts } from './workflow-headless-receipts'
import {
  readWorkflowHeadlessReport,
  type WorkflowHeadlessAgent,
  type WorkflowHeadlessReport
} from './workflow-headless-command'
import {
  readWorkflowHeadlessSessionOutput,
  resolveWorkflowCodexInvocationUsage
} from './workflow-headless-session-output'
import type { WorkflowTokenUsage } from '../../../shared/workflow-step-telemetry'
import { WorkflowOutputActivity } from './workflow-output-activity'
import { WorkflowHeadlessProtocol } from './workflow-headless-protocol'
import { WorkflowSessionJournal } from './workflow-session-journal'
import { workflowSessionIdSchema } from '../../../shared/workflow-step-telemetry'
import { z } from 'zod'
import { createUuidV4 } from '../../../shared/uuid-v4'

export async function executeWorkflowHeadlessInvocation(args: {
  runtime: {
    getOrchestrationDb(): { getDispatchContextById(id: string): { status: string } | undefined }
  }
  saved: SavedHeadlessWorker
  agent: WorkflowHeadlessAgent
  command: Parameters<typeof runProcess>[0]
  resumeSessionId?: string
  previousUsage?: WorkflowTokenUsage
  abort: AbortController
  receipts: WorkflowHeadlessReceipts
  assertAuthority(): unknown
  settle(report: WorkflowHeadlessReport): Promise<void>
}) {
  const { runtime, saved, agent, command, resumeSessionId, abort, receipts } = args
  const startedAt = performance.now()
  const invocationId = createUuidV4()
  const protocol = new WorkflowHeadlessProtocol(agent)
  let identityDirty = false
  let identityError: string | undefined
  let terminated = false
  let journal: WorkflowSessionJournal | undefined
  try {
    journal = new WorkflowSessionJournal(`${receipts.path(saved.dispatchId)}.conversation.jsonl`)
  } catch {
    // Viewing output must not prevent the worker from running.
  }
  const activity = new WorkflowOutputActivity(
    saved.dispatchId,
    (value, line) => {
      protocol.accept(value, line)
      const event = z
        .object({
          type: z.string().optional(),
          sessionId: z.unknown().optional(),
          thread_id: z.unknown().optional()
        })
        .safeParse(value)
      if (!event.success) {
        return
      }
      const id = workflowSessionIdSchema.safeParse(
        agent === 'codex' && event.data.type === 'thread.started'
          ? event.data.thread_id
          : agent !== 'codex'
            ? event.data.sessionId
            : undefined
      )
      if (id.success) {
        if (saved.sessionId && saved.sessionId !== id.data) {
          identityError =
            'CLI did not confirm the requested node session; completion was not accepted.'
          abort.abort()
          return
        }
        if (!saved.sessionId) {
          saved.sessionId = id.data
          identityDirty = true
        }
      }
    },
    (text, message) => {
      try {
        journal?.append(
          text,
          message
            ? {
                ...message,
                id: `${invocationId}:${message.id}`,
                blocks: message.blocks.map((block) =>
                  block.type === 'tool-call' || block.type === 'tool-result'
                    ? {
                        ...block,
                        ...(block.callId ? { callId: `${invocationId}:${block.callId}` } : {})
                      }
                    : block
                )
              }
            : undefined
        )
      } catch {
        journal = undefined
      }
    }
  )
  const flush = () => {
    if (identityDirty) {
      try {
        receipts.save(saved)
        identityDirty = false
      } catch {
        // Retry a transient receipt write on the next activity flush.
      }
    }
    if (activity.dirty) {
      try {
        receipts.saveActivity(activity.value)
        activity.dirty = false
      } catch {
        // A progress-log write failure must not terminate the agent.
      }
    }
  }
  flush()
  const monitor = setInterval(() => {
    try {
      args.assertAuthority()
      flush()
      const dispatch = runtime.getOrchestrationDb().getDispatchContextById(saved.dispatchId)
      if (!dispatch || !['pending', 'dispatched'].includes(dispatch.status)) {
        abort.abort()
      }
    } catch {
      abort.abort()
    }
  }, 1000)
  monitor.unref()
  try {
    const result = await runProcess(
      {
        ...command,
        onChildTerminated: () => {
          terminated = true
          command.onChildTerminated?.()
        },
        onStdout: (chunk) => {
          command.onStdout?.(chunk)
          activity.stdout(chunk)
        },
        onStderr: (chunk) => {
          command.onStderr?.(chunk)
          activity.stderr()
        }
      },
      'tail'
    )
    if (identityError) {
      throw new Error(identityError)
    }
    if (result.code !== 0 || result.timedOut || result.signal || command.signal?.aborted) {
      throw new Error(
        `Headless ${agent} exited without a complete report (exit ${result.code}, timeout ${result.timedOut}). Check CLI authentication, permissions and provider availability. No business-failure transition was taken.`
      )
    }
    activity.endOutput()
    const stdout = protocol.text(result)
    const output = readWorkflowHeadlessSessionOutput(agent, stdout)
    if (resumeSessionId && output.sessionId !== resumeSessionId) {
      throw new Error(
        'CLI did not confirm the requested node session; completion was not accepted.'
      )
    }
    if (resumeSessionId && !output.turnStarted) {
      throw new Error(
        'CLI did not confirm a new turn in the resumed session; historical output was not accepted.'
      )
    }
    if (agent === 'codex') {
      saved.sessionUsage = output.usage
    }
    saved.telemetry = {
      dispatchId: saved.dispatchId,
      durationMs: (saved.interruptedDurationMs ?? 0) + Math.round(performance.now() - startedAt),
      sessionMode: resumeSessionId ? 'resumed' : output.sessionId ? 'new' : 'unavailable',
      sessionId: output.sessionId,
      ...(agent === 'codex'
        ? resolveWorkflowCodexInvocationUsage(
            output.usage,
            resumeSessionId ? (args.previousUsage ?? null) : undefined
          )
        : output.usage)
    }
    saved.report = readWorkflowHeadlessReport(agent, stdout)
    if (saved.interruptedDurationMs !== undefined && agent !== 'codex') {
      saved.telemetry.inputTokens = null
      saved.telemetry.cachedInputTokens = null
      saved.telemetry.outputTokens = null
    }
    activity.add(saved.report.body)
    saved.sessionId = output.sessionId
    saved.status = 'report'
    receipts.save(saved)
    await args.settle(saved.report)
  } catch (error) {
    saved.pauseRequested ||= abort.signal.reason === 'workflow-user-interrupt'
    const paused = saved.pauseRequested && terminated
    saved.status = saved.report ? 'report' : paused ? 'paused' : 'error'
    saved.error =
      saved.pauseRequested && !terminated
        ? 'CLI process termination could not be confirmed. Resume is blocked to avoid overlapping invocations.'
        : paused
          ? undefined
          : error instanceof Error
            ? error.message
            : 'Headless execution failed.'
    receipts.save(saved)
  } finally {
    clearInterval(monitor)
    activity.finish(Boolean(saved.report), saved.status === 'paused')
    flush()
    saved.telemetry ??= {
      dispatchId: saved.dispatchId,
      durationMs: (saved.interruptedDurationMs ?? 0) + Math.round(performance.now() - startedAt),
      sessionMode: resumeSessionId ? 'resumed' : 'unavailable',
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null
    }
    receipts.save(saved)
  }
}
