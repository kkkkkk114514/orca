import { z } from 'zod'

const tokens = z.number().int().nonnegative().safe().nullable()
export const workflowSessionIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)

export const workflowTokenUsageSchema = z.object({
  inputTokens: tokens,
  cachedInputTokens: tokens,
  outputTokens: tokens
})
export type WorkflowTokenUsage = z.infer<typeof workflowTokenUsageSchema>

export const workflowStepTelemetrySchema = workflowTokenUsageSchema.extend({
  dispatchId: z.string().min(1),
  sessionMode: z.enum(['new', 'resumed', 'unavailable']),
  sessionId: workflowSessionIdSchema.optional(),
  durationMs: z.number().finite().nonnegative()
})
export type WorkflowStepTelemetry = z.infer<typeof workflowStepTelemetrySchema>

export function summarizeWorkflowTelemetry(steps: readonly WorkflowStepTelemetry[]) {
  const sum = (key: keyof WorkflowTokenUsage): number | null =>
    steps.length > 0 && steps.every((step) => step[key] !== null)
      ? steps.reduce((total, step) => total + (step[key] ?? 0), 0)
      : null
  const inputTokens = sum('inputTokens')
  const cachedInputTokens = sum('cachedInputTokens')
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens: sum('outputTokens'),
    durationMs: steps.reduce((total, step) => total + step.durationMs, 0),
    reportedSteps: steps.filter((step) =>
      [step.inputTokens, step.cachedInputTokens, step.outputTokens].every((value) => value !== null)
    ).length,
    cacheHitRate:
      inputTokens !== null && inputTokens > 0 && cachedInputTokens !== null
        ? cachedInputTokens / inputTokens
        : null
  }
}
