import { z } from 'zod'
import { workflowSessionIdSchema, workflowTokenUsageSchema } from './workflow-step-telemetry'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'
import { workspaceSessionRowSchema } from './workspace-session-history'

export const workflowNodeConversationSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('latest') }),
  z.strictObject({ mode: z.literal('new') }),
  z.strictObject({ mode: z.literal('existing'), key: z.string().regex(/^[a-f0-9]{64}$/) })
])
export type WorkflowNodeConversation = z.infer<typeof workflowNodeConversationSchema>

export const workflowResolvedConversationSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/),
  agent: z.custom<TuiAgent>(isTuiAgent),
  workspaceId: z.string().min(1),
  sessionId: workflowSessionIdSchema,
  transcriptPath: z.string().optional(),
  codexHome: z.string().nullable().optional(),
  usage: workflowTokenUsageSchema.optional()
})
export type WorkflowResolvedConversation = z.infer<typeof workflowResolvedConversationSchema>
export const workflowNodeConversationsSchema = z.record(
  z.string(),
  workflowResolvedConversationSchema
)
export type WorkflowNodeConversations = z.infer<typeof workflowNodeConversationsSchema>

export const workflowConversationOptionsSchema = z.object({
  supported: z.boolean(),
  rows: z
    .array(
      z.object({
        key: z.string().regex(/^[a-f0-9]{64}$/),
        title: z.string(),
        updatedAt: z.number(),
        archived: z.boolean(),
        history: workspaceSessionRowSchema.optional()
      })
    )
    .max(2000),
  issues: z.array(z.string()).max(10)
})
export type WorkflowConversationOption = z.infer<
  typeof workflowConversationOptionsSchema
>['rows'][number]
