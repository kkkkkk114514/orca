import { Flag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type { WorkflowCanvasDocument, WorkflowCanvasNode } from './workflow-canvas-document'
import { WorkflowNodeLaunchFields } from './WorkflowNodeLaunchFields'
import { WorkflowAgentPicker } from './WorkflowAgentPicker'
import { WorkflowNodeConversationFields } from './WorkflowNodeConversationFields'
import type { WorkflowExecutionTarget } from './WorkflowRunPanel'

export function WorkflowCanvasInspector({
  document,
  node,
  executionTarget = null,
  onChange
}: {
  document: WorkflowCanvasDocument
  node: WorkflowCanvasNode | undefined
  executionTarget?: WorkflowExecutionTarget | null
  onChange: (next: WorkflowCanvasDocument) => void
}) {
  const updateNode = (data: Partial<WorkflowCanvasNode['data']>): void => {
    if (!node) {
      return
    }
    onChange({
      ...document,
      version: data.launch || data.conversation ? 2 : document.version,
      nodes: document.nodes.map((candidate) =>
        candidate.id === node.id
          ? { ...candidate, data: { ...candidate.data, ...data } }
          : candidate
      )
    })
  }
  return (
    <div className="space-y-5 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">
          {node
            ? translate('workflows.nodeProperties', 'Node properties')
            : translate('workflows.workflowProperties', 'Workflow properties')}
        </h2>
        <p className="break-all font-mono text-2xs text-muted-foreground">
          {node?.id ??
            translate('workflows.selectNode', 'Select a node to edit its instructions and agent.')}
        </p>
      </div>
      {node ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="workflow-node-label">
              {translate('workflows.nodeLabel', 'Node name')}
            </Label>
            <Input
              id="workflow-node-label"
              value={node.data.label}
              maxLength={120}
              onChange={(event) => updateNode({ label: event.target.value })}
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={document.entry === node.id}
            onClick={() => onChange({ ...document, entry: node.id })}
          >
            <Flag />
            {document.entry === node.id
              ? translate('workflows.entry', 'Entry node')
              : translate('workflows.setEntry', 'Set as entry')}
          </Button>
          {node.data.kind === 'agent' ? (
            <>
              <WorkflowAgentPicker
                value={node.data.agent}
                target={executionTarget}
                onChange={(agent) =>
                  updateNode({ agent, launch: undefined, conversation: undefined })
                }
              />
              <WorkflowNodeConversationFields
                agent={node.data.agent}
                value={node.data.conversation}
                target={executionTarget}
                onChange={(conversation) => updateNode({ conversation })}
              />
              <WorkflowNodeLaunchFields
                agent={node.data.agent}
                value={node.data.launch}
                target={executionTarget}
                onChange={(launch) => updateNode({ launch })}
              />
              <div className="space-y-2">
                <Label htmlFor="workflow-node-prompt">
                  {translate('workflows.prompt', 'Instructions')}
                </Label>
                <Textarea
                  id="workflow-node-prompt"
                  className="min-h-48 resize-y"
                  value={node.data.prompt}
                  maxLength={64000}
                  onChange={(event) => updateNode({ prompt: event.target.value })}
                />
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="workflow-node-outcome">
                {translate('workflows.outcome', 'Final outcome')}
              </Label>
              <Select
                value={node.data.outcome}
                onValueChange={(value) => {
                  if (value === 'succeeded' || value === 'failed') {
                    updateNode({ outcome: value })
                  }
                }}
              >
                <SelectTrigger id="workflow-node-outcome" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="succeeded">
                    {translate('workflows.success', 'Success')}
                  </SelectItem>
                  <SelectItem value="failed">{translate('workflows.failed', 'Failed')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="border-t pt-4" />
        </>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="workflow-name">{translate('workflows.name', 'Workflow name')}</Label>
        <Input
          id="workflow-name"
          value={document.name}
          maxLength={120}
          onChange={(event) => onChange({ ...document, name: event.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="workflow-max-steps">
          {translate('workflows.maxSteps', 'Maximum steps')}
        </Label>
        <Input
          id="workflow-max-steps"
          type="number"
          min={1}
          max={1000}
          value={document.maxSteps}
          onChange={(event) => {
            const value = event.target.valueAsNumber
            if (Number.isInteger(value) && value >= 1 && value <= 1000) {
              onChange({ ...document, maxSteps: value })
            }
          }}
        />
        <p className="text-2xs text-muted-foreground">
          {translate(
            'workflows.stepsHint',
            'Stops repeated rework when the step limit is reached.'
          )}
        </p>
      </div>
    </div>
  )
}
