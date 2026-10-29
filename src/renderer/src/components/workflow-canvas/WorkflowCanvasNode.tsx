import { createContext, memo, useContext } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Bot, Check, Flag, GripHorizontal, MessageSquare, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { getAgentLabel } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import type { WorkflowCanvasNode as CanvasNode } from './workflow-canvas-document'
import type { WorkflowRunSnapshot } from '../../../../shared/workflow-run-contract'
import { workflowNodeExecution } from './workflow-node-execution'
import { WorkflowActivityStatus } from './WorkflowStepActivity'

export const WorkflowCanvasEntryContext = createContext('')
export const WorkflowCanvasRunContext = createContext<WorkflowRunSnapshot | null>(null)
export const WorkflowCanvasSessionContext = createContext<((nodeId: string) => void) | null>(null)

export const WorkflowCanvasNode = memo(function WorkflowCanvasNode({
  id,
  data,
  selected
}: NodeProps<CanvasNode>) {
  const entry = useContext(WorkflowCanvasEntryContext)
  const openSession = useContext(WorkflowCanvasSessionContext)
  const snapshot = useContext(WorkflowCanvasRunContext)
  const execution = workflowNodeExecution(id, snapshot)
  const hasConversation = snapshot?.execution?.steps.some(
    (step) => step.nodeId === id && step.dispatchId
  )
  const isAgent = data.kind === 'agent'
  const Icon = isAgent ? Bot : data.outcome === 'succeeded' ? Check : X
  return (
    <div
      data-run-state={execution?.state}
      data-run-visits={execution?.visits}
      className={cn(
        'workflow-node w-64 rounded-xl border bg-card text-card-foreground shadow-xs',
        selected && 'ring-2 ring-ring'
      )}
    >
      <Handle
        type="target"
        id="input"
        position={Position.Left}
        aria-label={translate('workflows.input', 'Input')}
      />
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <Icon
          className={cn(
            'size-4 shrink-0',
            !isAgent && (data.outcome === 'succeeded' ? 'text-status-success' : 'text-destructive')
          )}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{data.label || id}</span>
        {entry === id && (
          <Flag
            className="size-3 text-muted-foreground"
            aria-label={translate('workflows.entry', 'Entry node')}
          />
        )}
        {isAgent && openSession && (
          <span className="nodrag nopan">
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={!hasConversation}
              title={translate('workflows.openSession', 'Open node conversation')}
              aria-label={translate('workflows.openSession', 'Open node conversation')}
              onClick={(event) => {
                event.stopPropagation()
                openSession(id)
              }}
            >
              <MessageSquare className="size-3.5" />
            </Button>
          </span>
        )}
        <GripHorizontal className="size-3.5 text-muted-foreground/50" />
      </div>
      {execution && (
        <div
          className="flex items-center justify-between border-b px-3 py-1.5 text-2xs"
          aria-live="polite"
        >
          <span
            className={cn(
              execution.state === 'succeeded' && 'text-status-success',
              execution.state === 'failed' && 'text-destructive'
            )}
          >
            {['running', 'quiet', 'finished', 'interrupted'].includes(execution.state) ? (
              <WorkflowActivityStatus
                state={
                  execution.state === 'running'
                    ? 'running'
                    : execution.state === 'quiet'
                      ? 'quiet'
                      : execution.state === 'finished'
                        ? 'finished'
                        : 'interrupted'
                }
              />
            ) : execution.state === 'succeeded' ? (
              translate('workflows.runSucceeded', 'Succeeded')
            ) : execution.state === 'failed' ? (
              translate('workflows.runFailed', 'Failed')
            ) : execution.state === 'waiting' ? (
              translate('workflows.awaitingReport', 'Awaiting accepted report')
            ) : (
              translate('workflows.notVisited', 'Not visited')
            )}
          </span>
          <span className="text-muted-foreground">
            {translate('workflows.nodeVisits', '{{count}} visits', { count: execution.visits })}
          </span>
        </div>
      )}
      {isAgent ? (
        <>
          <div className="space-y-2 px-3 py-3">
            <span className="rounded-md bg-muted px-2 py-1 font-mono text-2xs">
              {getAgentLabel(data.agent)}
            </span>
            <p className="line-clamp-2 min-h-8 text-2xs leading-relaxed text-muted-foreground">
              {data.prompt ||
                translate('workflows.emptyPrompt', 'Select this node to add instructions.')}
            </p>
          </div>
          <div className="relative flex h-8 items-center justify-end border-t px-3 text-2xs text-status-success">
            {translate('workflows.success', 'Success')}
            <Handle
              type="source"
              id="succeeded"
              position={Position.Right}
              className="workflow-port-success"
              aria-label={translate('workflows.success', 'Success')}
            />
          </div>
          <div className="relative flex h-8 items-center justify-end border-t px-3 text-2xs text-destructive">
            {translate('workflows.failure', 'Failure / rework')}
            <Handle
              type="source"
              id="failed"
              position={Position.Right}
              className="workflow-port-failure"
              aria-label={translate('workflows.failure', 'Failure / rework')}
            />
          </div>
        </>
      ) : (
        <div className="px-3 py-3 text-2xs text-muted-foreground">
          {data.outcome === 'succeeded'
            ? translate('workflows.endSuccess', 'End workflow successfully')
            : translate('workflows.endFailure', 'End workflow with failure')}
        </div>
      )}
    </div>
  )
})
