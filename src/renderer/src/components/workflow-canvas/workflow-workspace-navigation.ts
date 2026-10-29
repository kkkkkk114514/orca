import { useAppStore } from '@/store'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { setAutomationWorkspaceView } from '../automations/automation-workspace-view'

export function openWorkspaceWorkflow(
  worktreeId: string,
  executionHostId?: ExecutionHostId
): boolean {
  window.dispatchEvent(new Event('workflow-canvas-flush'))
  const activated = activateAndRevealWorkspace(worktreeId, {
    executionHostId,
    providesInitialSurface: true,
    restoreAgentSessions: false,
    navigationIntent: 'user-open'
  })
  if (activated === false) {
    return false
  }
  setAutomationWorkspaceView('workflows')
  useAppStore.getState().openAutomationsPage()
  return true
}
