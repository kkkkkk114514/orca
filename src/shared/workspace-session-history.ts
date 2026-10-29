import { z } from 'zod'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'
import { workflowSessionEntrySchema } from './workflow-session-view'

export const WorkspaceSessionsList = z.strictObject({
  worktree: z.string().min(1).max(512),
  archived: z.boolean().optional(),
  offset: z.number().int().min(0).max(100_000).optional(),
  force: z.boolean().optional()
})
export const WorkspaceSessionSelect = z.strictObject({
  worktree: z.string().min(1).max(512),
  key: z.string().regex(/^[a-f0-9]{64}$/)
})
export const WorkspaceSessionArchive = WorkspaceSessionSelect.extend({ archived: z.boolean() })
export const WorkspaceSessionRead = WorkspaceSessionSelect.extend({
  before: z.number().int().nonnegative().safe().optional()
})
export const workspaceSessionRowSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/),
  agent: z.custom<TuiAgent>(isTuiAgent),
  title: z.string().max(500),
  updatedAt: z.number(),
  archived: z.boolean(),
  running: z.boolean().optional(),
  source: z.enum(['cli', 'workflow']),
  workflow: z.object({ id: z.string().uuid(), nodeId: z.string() }).optional()
})
export const workspaceSessionListSchema = z.object({
  rows: z.array(workspaceSessionRowSchema).max(50),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  issues: z.array(z.string()).max(10)
})
export const workspaceSessionPageSchema = z.object({
  row: workspaceSessionRowSchema,
  entries: z.array(workflowSessionEntrySchema).max(100),
  before: z.number().int().nonnegative().safe(),
  hasMore: z.boolean(),
  limited: z.boolean()
})
export type WorkspaceSessionRow = z.infer<typeof workspaceSessionRowSchema>
export function workspaceHistoryViewId(key: string) {
  WorkspaceSessionSelect.shape.key.parse(key)
  return `workspace-history:${key}`
}
export function parseWorkspaceHistoryView(id: string) {
  if (!id.startsWith('workspace-history:')) {
    return null
  }
  const parsed = WorkspaceSessionSelect.shape.key.safeParse(id.slice('workspace-history:'.length))
  return parsed.success ? parsed.data : null
}
export function isReadOnlySessionView(id: string) {
  return id.startsWith('workflow-view:') || id.startsWith('workspace-history:')
}
