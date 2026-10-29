import { useAppStore } from '@/store'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { Tab } from '../../../../shared/tab-types'
import { workflowSessionViewId } from '../../../../shared/workflow-session-view'
import { readWorkflowSessionPage } from './workflow-session-client'

export function activateWorkflowSessionTab(tab: Tab) {
  const result = activateAndRevealWorkspace(tab.worktreeId, {
    executionHostId: tab.executionHostId,
    providesInitialSurface: true,
    restoreAgentSessions: false
  })
  if (result === false) {
    throw new Error('Workflow workspace is unavailable on its owning host')
  }
  const state = useAppStore.getState()
  state.focusGroup(tab.worktreeId, tab.groupId)
  state.activateTab(tab.id, { worktreeId: tab.worktreeId })
  state.setActiveTabType('agent-session', tab.worktreeId)
  state.setActiveView('terminal')
}

export async function openWorkflowSession(args: {
  id: string
  nodeId: string
  label: string
  target: RuntimeClientTarget
}) {
  const page = await readWorkflowSessionPage(args.target, { id: args.id, nodeId: args.nodeId })
  const entityId = workflowSessionViewId(args.id, args.nodeId)
  const executionHostId = executionHostIdForStructuredTarget(args.target)
  const state = useAppStore.getState()
  const existing = state.unifiedTabsByWorktree[page.workspaceId]?.find(
    (tab) => tab.entityId === entityId && tab.executionHostId === executionHostId
  )
  const tab =
    existing ??
    state.createUnifiedTab(page.workspaceId, 'agent-session', {
      id: `${executionHostId}:${entityId}`,
      entityId,
      executionHostId,
      agentSessionAgent: page.agent,
      label: args.label,
      activate: true
    })
  activateWorkflowSessionTab(tab)
  window.dispatchEvent(new Event('workspace-session-history-changed'))
}
