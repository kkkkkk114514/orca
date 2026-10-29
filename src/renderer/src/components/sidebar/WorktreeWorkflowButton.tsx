import { Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { openWorkspaceWorkflow } from '../workflow-canvas/workflow-workspace-navigation'

export function WorktreeWorkflowButton({
  worktreeId,
  label,
  executionHostId,
  disabled,
  onOpened
}: {
  worktreeId: string
  label: string
  executionHostId?: ExecutionHostId
  disabled?: boolean
  onOpened?(): void
}) {
  const title = translate('workflows.openWorkspace', 'Open workflow for {{workspace}}', {
    workspace: label
  })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="sidebar"
          size="icon-xs"
          disabled={disabled}
          aria-label={title}
          data-workspace-workflow={worktreeId}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            if (openWorkspaceWorkflow(worktreeId, executionHostId)) {
              onOpened?.()
            }
          }}
        >
          <Workflow className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {title}
      </TooltipContent>
    </Tooltip>
  )
}
