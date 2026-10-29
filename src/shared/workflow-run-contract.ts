import { z } from 'zod'
import { workflowDefinitionSchema } from './workflow-definition'
import { workflowExecutionSchema } from './workflow-execution'
import { workflowStepTelemetrySchema } from './workflow-step-telemetry'
import { workflowStepActivitySchema } from './workflow-step-activity'

export const workflowRunStartSchema = z.strictObject({
  id: z.string().uuid(),
  worktree: z.string().min(1).max(256),
  definition: workflowDefinitionSchema,
  input: z.string().trim().min(1).max(64_000),
  workflowId: z.string().uuid().optional()
})
export const workflowRunIdSchema = z.strictObject({ id: z.string().uuid() })
export const workflowRunSnapshotSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.number(),
  worktree: z.string(),
  phase: z.enum(['starting', 'running', 'paused', 'succeeded', 'failed', 'attention']),
  execution: workflowExecutionSchema.optional(),
  telemetry: z.array(workflowStepTelemetrySchema).max(1000).optional(),
  activity: z.array(workflowStepActivitySchema).max(5).optional(),
  coordinator: z.string().optional(),
  waiting: z.string().optional(),
  error: z.string().optional()
})

export type WorkflowRunStart = z.infer<typeof workflowRunStartSchema>
export type WorkflowRunSnapshot = z.infer<typeof workflowRunSnapshotSchema>
