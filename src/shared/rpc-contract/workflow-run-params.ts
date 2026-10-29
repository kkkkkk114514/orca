export { workflowStorageRequestSchema as WorkflowStorage } from '../workflow-run-storage'
export { workflowRunStartSchema as WorkflowRunStart } from '../workflow-run-contract'
export { workflowSessionReadSchema as WorkflowSessionRead } from '../workflow-session-view'
export { workflowSessionControlSchema as WorkflowSessionControl } from '../workflow-session-view'
import { workflowRunIdSchema } from '../workflow-run-contract'
import {
  ORCA_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY,
  ORCA_RUNTIME_RPC_BROWSER_UI_SOURCE
} from '../runtime-rpc-feature-interaction-source'
import { z } from 'zod'
import type { TuiAgent } from '../tui-agent'
import { isTuiAgent } from '../tui-agent-config'

export const WorkflowRunId = workflowRunIdSchema.extend({
  [ORCA_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY]: z
    .literal(ORCA_RUNTIME_RPC_BROWSER_UI_SOURCE)
    .optional()
})

export const WorkflowNodeOptionsParams = z.object({
  agent: z.custom<TuiAgent>(isTuiAgent),
  worktree: z.string().min(1),
  profile: z.string().max(512).optional()
})
export const WorkflowConversationsParams = z.strictObject({
  worktree: z.string().min(1).max(512),
  agent: z.custom<TuiAgent>(isTuiAgent),
  force: z.boolean().optional()
})
