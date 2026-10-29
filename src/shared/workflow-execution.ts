import { z } from 'zod'
import { workflowDefinitionSchema } from './workflow-definition'
import { workflowReportFilesSchema } from './workflow-report-files'

export const workflowStepReportSchema = z.object({
  outcome: z.enum(['succeeded', 'failed']),
  messageId: z.string().min(1),
  body: z.string().max(16_000),
  reportPath: z.string().max(4096).optional(),
  filesModified: workflowReportFilesSchema
})

const stepSchema = z.strictObject({
  nodeId: z.string(),
  startRequestId: z.string().uuid(),
  startRuntimeId: z.string().min(1),
  releaseRequestId: z.string().uuid(),
  taskId: z.string().min(1).optional(),
  dispatchId: z.string().min(1).optional(),
  report: workflowStepReportSchema.optional(),
  released: z.boolean()
})

export const workflowExecutionSchema = z
  .strictObject({
    version: z.literal(1),
    definition: workflowDefinitionSchema,
    input: z.string().max(64_000),
    context: z.strictObject({
      worktree: z.string().min(1),
      from: z.string().min(1).optional(),
      sessionId: z.string().min(1).optional(),
      target: z.string().min(1)
    }),
    runRequestId: z.string().uuid(),
    runRuntimeId: z.string().min(1),
    runId: z.string().min(1).optional(),
    cursor: z.string(),
    status: z.enum(['running', 'succeeded', 'failed']),
    reason: z.literal('step_limit').optional(),
    steps: z.array(stepSchema).max(1000)
  })
  .superRefine((state, ctx) => {
    let cursor = state.definition.entry
    let valid = state.steps.length <= state.definition.maxSteps
    const requests = new Set([state.runRequestId])
    const dispatches = new Set<string>()
    const tasks = new Set<string>()
    for (const [index, step] of state.steps.entries()) {
      const node = state.definition.nodes.find((candidate) => candidate.id === cursor)
      valid &&= node?.type === 'agent' && node.id === step.nodeId
      valid &&= Boolean(step.taskId) === Boolean(step.dispatchId)
      valid &&= !step.report || Boolean(step.dispatchId)
      valid &&= !step.released || Boolean(step.report)
      valid &&= index === state.steps.length - 1 || step.released
      for (const request of [step.startRequestId, step.releaseRequestId]) {
        valid &&= !requests.has(request)
        requests.add(request)
      }
      if (step.dispatchId && step.taskId) {
        valid &&= !dispatches.has(step.dispatchId) && !tasks.has(step.taskId)
        dispatches.add(step.dispatchId)
        tasks.add(step.taskId)
      }
      if (step.released && step.report && node?.type === 'agent') {
        cursor = step.report.outcome === 'succeeded' ? node.onSuccess : node.onFailure
      }
    }
    valid &&= cursor === state.cursor && (state.steps.length === 0 || Boolean(state.runId))
    const current = state.definition.nodes.find((node) => node.id === cursor)
    if (state.reason === 'step_limit') {
      valid &&=
        state.status === 'failed' &&
        current?.type === 'agent' &&
        state.steps.length === state.definition.maxSteps &&
        state.steps.every((step) => step.released)
    } else if (state.status !== 'running') {
      valid &&= current?.type === 'end' && current.outcome === state.status
    }
    if (!valid) {
      ctx.addIssue({ code: 'custom', message: 'Inconsistent workflow checkpoint' })
    }
  })

export type WorkflowExecution = z.infer<typeof workflowExecutionSchema>
export type WorkflowStep = WorkflowExecution['steps'][number]
export type WorkflowStepReport = z.infer<typeof workflowStepReportSchema>
