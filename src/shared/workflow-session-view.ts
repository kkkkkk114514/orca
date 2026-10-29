import { z } from 'zod'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'
import { sessionRecordBlockSchema } from './session-record-content'

const identity = z.object({
  id: z.string().uuid(),
  nodeId: z
    .string()
    .max(64)
    .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
})
const prefix = 'workflow-view:'

export function workflowSessionViewId(id: string, nodeId: string): string {
  const value = identity.parse({ id, nodeId })
  return `${prefix}${value.id}:${value.nodeId}`
}

export function isWorkflowSessionView(id: string): boolean {
  return id.startsWith(prefix)
}

export function parseWorkflowSessionView(id: string) {
  if (!isWorkflowSessionView(id)) {
    return null
  }
  const parts = id.slice(prefix.length).split(':')
  if (parts.length !== 2) {
    return null
  }
  const [runId, nodeId] = parts
  const result = identity.safeParse({ id: runId, nodeId })
  return result.success ? result.data : null
}

export const workflowSessionReadSchema = identity.extend({
  dispatchId: z
    .string()
    .regex(/^ctx_[a-zA-Z0-9_-]+$/)
    .optional(),
  before: z.number().int().nonnegative().safe().optional()
})

export const workflowSessionControlSchema = identity
  .extend({
    dispatchId: z.string().regex(/^ctx_[a-zA-Z0-9_-]+$/),
    requestId: z.string().uuid(),
    action: z.enum(['interrupt', 'message']),
    text: z.string().trim().min(1).max(16_000).optional()
  })
  .superRefine((value, ctx) => {
    if ((value.action === 'message') !== Boolean(value.text)) {
      ctx.addIssue({ code: 'custom', message: 'Only message actions require text' })
    }
  })
export type WorkflowSessionControl = z.infer<typeof workflowSessionControlSchema>

export const workflowSessionEntrySchema = z.object({
  id: z.string().max(512),
  role: z.enum(['user', 'assistant', 'tool', 'system', 'activity']),
  text: z.string().max(16_000),
  blocks: z.array(sessionRecordBlockSchema).max(100).optional().catch(undefined),
  limited: z.boolean().optional(),
  at: z.number().optional()
})

export const workflowSessionPageSchema = identity.extend({
  workspaceId: z.string().min(1),
  agent: z.custom<TuiAgent>(isTuiAgent),
  visits: z
    .array(
      z.object({
        dispatchId: z.string(),
        outcome: z.enum(['running', 'succeeded', 'failed', 'interrupted'])
      })
    )
    .max(1000),
  dispatchId: z.string(),
  entries: z.array(workflowSessionEntrySchema).max(100),
  source: z.enum(['journal', 'transcript', 'activity', 'unavailable']),
  hasMore: z.boolean(),
  before: z.number().int().nonnegative().safe(),
  limited: z.boolean(),
  cleared: z.boolean().optional(),
  control: z
    .object({
      paused: z.boolean(),
      pendingMessages: z.array(z.object({ id: z.string(), text: z.string().max(16_000) })).max(100)
    })
    .optional(),
  report: z.string().max(16_000).optional(),
  task: z.string().max(64_000),
  instructions: z.string().max(64_000)
})

export type WorkflowSessionRead = z.infer<typeof workflowSessionReadSchema>
export type WorkflowSessionEntry = z.infer<typeof workflowSessionEntrySchema>
export type WorkflowSessionPage = z.infer<typeof workflowSessionPageSchema>
