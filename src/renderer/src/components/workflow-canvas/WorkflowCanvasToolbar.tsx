import {
  Download,
  LayoutGrid,
  Plus,
  Redo2,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Upload
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { ReactNode } from 'react'

function Tool({
  label,
  children,
  ...props
}: { label: string; children: ReactNode } & Omit<React.ComponentProps<typeof Button>, 'children'>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function WorkflowCanvasToolbar({
  onAdd,
  onImport,
  onExport,
  onLayout,
  onDelete,
  onInspector,
  undo,
  redo,
  canUndo,
  canRedo,
  canDelete,
  canAdd,
  valid,
  locked = false
}: {
  onAdd: (kind: 'agent' | 'succeeded' | 'failed') => void
  onImport: () => void
  onExport: (canvas: boolean) => void
  onLayout: () => void
  onDelete: () => void
  onInspector: () => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  canDelete: boolean
  canAdd: boolean
  valid: boolean
  locked?: boolean
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-1 border-b bg-background px-3 py-2"
      role="toolbar"
      aria-label={translate('workflows.canvasTools', 'Canvas tools')}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" disabled={!canAdd}>
            <Plus />
            {translate('workflows.addNode', 'Add node')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => onAdd('agent')}>
            {translate('workflows.agent', 'Agent')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onAdd('succeeded')}>
            {translate('workflows.endSuccess', 'End workflow successfully')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onAdd('failed')}>
            {translate('workflows.endFailure', 'End workflow with failure')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="mx-2 h-4 border-l" />
      <Tool label={translate('workflows.undo', 'Undo')} onClick={undo} disabled={!canUndo}>
        <Undo2 />
      </Tool>
      <Tool label={translate('workflows.redo', 'Redo')} onClick={redo} disabled={!canRedo}>
        <Redo2 />
      </Tool>
      <Tool
        label={translate('workflows.layout', 'Arrange nodes')}
        onClick={onLayout}
        disabled={locked}
      >
        <LayoutGrid />
      </Tool>
      <Tool
        label={translate('workflows.delete', 'Delete selection')}
        onClick={onDelete}
        disabled={!canDelete}
      >
        <Trash2 />
      </Tool>
      <div className="min-w-2 flex-1" />
      <Tool
        label={translate('workflows.import', 'Import JSON')}
        onClick={onImport}
        disabled={locked}
      >
        <Upload />
      </Tool>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            <Download />
            {translate('workflows.export', 'Export')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={!valid} onSelect={() => onExport(false)}>
            {translate('workflows.exportWorkflow', 'Workflow JSON (executor)')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onExport(true)}>
            {translate('workflows.exportCanvas', 'Canvas JSON (with layout)')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tool label={translate('workflows.properties', 'Properties')} onClick={onInspector}>
        <SlidersHorizontal />
      </Tool>
    </div>
  )
}
