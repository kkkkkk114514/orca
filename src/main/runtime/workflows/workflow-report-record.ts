import { z } from 'zod'
import { workflowStepReportSchema } from '../../../shared/workflow-execution'

const recipient = z.object({
  nodeId: z.string(),
  taskId: z.string(),
  dispatchId: z.string()
})

export const workflowReportRecordSchema = z.object({
  version: z.literal(1),
  workflowId: z.string().uuid(),
  runId: z.string().min(1),
  workflowName: z.string(),
  workspace: z.string(),
  nodeId: z.string(),
  agent: z.string(),
  step: z.number().int().positive(),
  visit: z.number().int().positive(),
  taskId: z.string(),
  dispatchId: z.string(),
  createdAt: z.number(),
  sourceReportPath: z.string().optional(),
  source: recipient.extend({ messageId: z.string(), reportPath: z.string().optional() }).optional(),
  report: workflowStepReportSchema,
  route: z.object({
    nextNodeId: z.string(),
    targetType: z.enum(['agent', 'end']),
    dispatchedTo: recipient.optional()
  })
})
export type WorkflowReportRecord = z.infer<typeof workflowReportRecordSchema>

export function renderWorkflowReport(record: WorkflowReportRecord): string {
  return [
    `# ${record.workflowName}: ${record.nodeId}`,
    '',
    `- Workflow: ${record.workflowId}`,
    `- Run: ${record.runId}`,
    `- Workspace: ${record.workspace}`,
    `- Node visit: ${record.visit}; workflow step: ${record.step}`,
    `- Task: ${record.taskId}; dispatch: ${record.dispatchId}`,
    `- Accepted message: ${record.report.messageId}`,
    `- Outcome: ${record.report.outcome}`,
    `- Source: ${record.source ? `${record.source.nodeId} / ${record.source.dispatchId}` : 'Entry step'}`,
    `- Selected destination: ${record.route.nextNodeId} (${record.route.targetType})`,
    `- Dispatched to: ${record.route.dispatchedTo ? `${record.route.dispatchedTo.nodeId} / ${record.route.dispatchedTo.dispatchId}` : 'Not dispatched'}`,
    '',
    '## Accepted report',
    '',
    record.report.body,
    '',
    '## Changed files',
    '',
    ...record.report.filesModified.map((file) => `- ${file}`),
    '',
    'Generated from report.json by Orca. Edit project files rather than this derived report.',
    ''
  ].join('\n')
}
