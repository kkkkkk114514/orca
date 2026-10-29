import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { WorkerStartParams } from '../../../shared/rpc-contract/orchestration-worker-start-params'
import { writeDurableSecureJsonFile } from '../../../shared/secure-file'
import {
  workflowSessionIdSchema,
  workflowStepTelemetrySchema,
  workflowTokenUsageSchema,
  type WorkflowStepTelemetry,
  type WorkflowTokenUsage
} from '../../../shared/workflow-step-telemetry'
import { resolveWorkflowCodexInvocationUsage } from './workflow-headless-session-output'
import {
  WORKFLOW_OUTPUT_QUIET_MS,
  workflowStepActivitySchema,
  type WorkflowStepActivity
} from '../../../shared/workflow-step-activity'

export const workflowNodeSessionBindingSchema = z.object({
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  workspaceId: z.string().min(1),
  agent: z.enum(['dsh', 'zcode', 'codex']),
  configurationKey: z.string().regex(/^[a-f0-9]{64}$/)
})
export type WorkflowNodeSessionBinding = z.infer<typeof workflowNodeSessionBindingSchema>

const savedSchema = z.object({
  handle: z.string(),
  coordinator: z.string(),
  taskId: z.string(),
  dispatchId: z.string(),
  paneKey: z.string(),
  processIncarnation: z.string(),
  settlementRequestId: z.string().uuid(),
  status: z.enum(['running', 'report', 'settled', 'error', 'paused']),
  pauseRequested: z.boolean().optional(),
  interruptedDurationMs: z.number().finite().nonnegative().optional(),
  restart: z.object({ params: WorkerStartParams, artifacts: z.string().optional() }).optional(),
  report: z
    .object({
      outcome: z.enum(['succeeded', 'failed']),
      body: z.string(),
      filesModified: z.array(z.string())
    })
    .optional(),
  error: z.string().optional(),
  binding: workflowNodeSessionBindingSchema.optional(),
  sessionId: workflowSessionIdSchema.optional(),
  codexHome: z.string().nullable().optional(),
  sessionUsage: workflowTokenUsageSchema.optional(),
  telemetry: workflowStepTelemetrySchema.optional()
})
export type SavedHeadlessWorker = z.infer<typeof savedSchema>

export class WorkflowHeadlessReceipts {
  constructor(private readonly root: string) {}

  path(dispatch: string) {
    if (!/^ctx_[a-zA-Z0-9_-]+$/.test(dispatch)) {
      throw new Error('Invalid headless dispatch identity.')
    }
    return join(this.root, `${dispatch}.json`)
  }

  save(saved: SavedHeadlessWorker) {
    writeDurableSecureJsonFile(this.path(saved.dispatchId), saved)
  }

  async read(dispatch: string) {
    return savedSchema.parse(JSON.parse(await readFile(this.path(dispatch), 'utf8')))
  }

  saveActivity(activity: WorkflowStepActivity) {
    writeDurableSecureJsonFile(`${this.path(activity.dispatchId)}.activity.json`, activity)
  }

  async readActivity(dispatch: string) {
    try {
      return workflowStepActivitySchema.parse(
        JSON.parse(await readFile(`${this.path(dispatch)}.activity.json`, 'utf8'))
      )
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return undefined
      }
      throw error
    }
  }

  async activity(
    dispatches: readonly string[],
    isActive: (dispatch: string) => boolean
  ): Promise<WorkflowStepActivity[]> {
    const values = await Promise.all(
      dispatches.slice(-5).map(async (dispatch) => {
        const value = await this.readActivity(dispatch)
        if (!value || value.dispatchId !== dispatch) {
          return []
        }
        if (value.state === 'running') {
          value.state = !isActive(dispatch)
            ? 'interrupted'
            : Date.now() - (value.lastOutputAt ?? value.startedAt) >= WORKFLOW_OUTPUT_QUIET_MS
              ? 'quiet'
              : 'running'
        }
        return [value]
      })
    )
    return values.flat()
  }

  async telemetry(dispatches: readonly string[]): Promise<WorkflowStepTelemetry[]> {
    const saved = await Promise.all(
      dispatches.map(async (dispatch) => {
        try {
          return await this.read(dispatch)
        } catch {
          return undefined
        }
      })
    )
    const totals = new Map<string, WorkflowTokenUsage>()
    return saved.flatMap((receipt) => {
      const step = receipt?.telemetry
      if (!receipt || !step) {
        return []
      }
      if (receipt.binding?.agent !== 'codex' || !receipt.sessionId) {
        return [step]
      }
      const key = JSON.stringify([receipt.binding, receipt.coordinator, receipt.sessionId])
      const cumulative = receipt.sessionUsage ?? step
      // Older Codex receipts stored cumulative counters directly in telemetry.
      const usage = receipt.sessionUsage
        ? step
        : resolveWorkflowCodexInvocationUsage(
            cumulative,
            step.sessionMode === 'resumed' ? (totals.get(key) ?? null) : undefined
          )
      if (receipt.status === 'settled' && receipt.report) {
        totals.set(key, cumulative)
      }
      return [{ ...step, ...usage }]
    })
  }
}
