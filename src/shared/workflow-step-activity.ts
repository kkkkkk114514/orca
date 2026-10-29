import { z } from 'zod'

export const workflowStepActivitySchema = z.object({
  dispatchId: z.string(),
  startedAt: z.number(),
  lastOutputAt: z.number().optional(),
  state: z.enum(['running', 'quiet', 'finished', 'interrupted']),
  entries: z
    .array(
      z.object({
        id: z.number().int().nonnegative().optional(),
        at: z.number(),
        text: z.string().max(800)
      })
    )
    .max(30),
  omitted: z.number().int().nonnegative()
})

export type WorkflowStepActivity = z.infer<typeof workflowStepActivitySchema>
export const WORKFLOW_OUTPUT_QUIET_MS = 120_000
