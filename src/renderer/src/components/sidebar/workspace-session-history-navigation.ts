import { useAppStore } from '@/store'
import type { WorkspaceSessionRow } from '../../../../shared/workspace-session-history'
import { workspaceHistoryViewId } from '../../../../shared/workspace-session-history'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'
import {
  activateWorkflowSessionTab,
  openWorkflowSession
} from '../workflow-canvas/workflow-session-navigation'

export async function openWorkspaceHistorySession(args: {
  row: WorkspaceSessionRow
  worktreeId: string
  target: RuntimeClientTarget
}) {
  if (args.row.workflow) {
    await openWorkflowSession({ ...args.row.workflow, label: args.row.title, target: args.target })
    return
  }
  const entityId = workspaceHistoryViewId(args.row.key)
  const executionHostId = executionHostIdForStructuredTarget(args.target)
  const state = useAppStore.getState()
  const existing = state.unifiedTabsByWorktree[args.worktreeId]?.find(
    (tab) => tab.entityId === entityId && tab.executionHostId === executionHostId
  )
  const tab =
    existing ??
    state.createUnifiedTab(args.worktreeId, 'agent-session', {
      id: `${executionHostId}:${entityId}`,
      entityId,
      executionHostId,
      agentSessionAgent: args.row.agent,
      label: args.row.title,
      activate: true
    })
  activateWorkflowSessionTab(tab)
}
