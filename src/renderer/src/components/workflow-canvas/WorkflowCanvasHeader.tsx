import { Workflow } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { useWorkflowCanvasDocument } from './use-workflow-canvas-document'

export function WorkflowCanvasHeader({
  name,
  saveState
}: {
  name: string
  saveState: ReturnType<typeof useWorkflowCanvasDocument>['saveState']
}) {
  return (
    <header className="flex items-center gap-3 border-b px-4 py-3">
      <Workflow className="size-5 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-medium">
          {translate('workflows.title', 'Workflow canvas')}
        </h1>
        <p className="truncate text-xs text-muted-foreground">{name}</p>
      </div>
      <span className="text-2xs text-muted-foreground" role="status">
        {saveState === 'saved'
          ? translate('workflows.saved', 'Saved on this device')
          : saveState === 'failed'
            ? translate('workflows.saveFailed', 'Local save failed — export a canvas backup')
            : translate('workflows.saving', 'Saving…')}
      </span>
    </header>
  )
}
