import { useActiveWorktree } from '@/store/selectors'
import { useWorktreeRuntimeTarget } from '@/runtime/use-worktree-runtime-target'
import WorkflowCanvasPage from './WorkflowCanvasPage'

export default function WorkflowCanvasWorkspacePage() {
  const workspace = useActiveWorktree()
  const target = useWorktreeRuntimeTarget(workspace?.id)
  return (
    <WorkflowCanvasPage
      executionTarget={
        workspace && target
          ? {
              target,
              worktreeId: workspace.id,
              label: workspace.displayName || workspace.branch || workspace.id
            }
          : null
      }
    />
  )
}
