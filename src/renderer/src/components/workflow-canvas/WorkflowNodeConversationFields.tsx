import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { translate } from '@/i18n/i18n'
import type { WorkflowNodeConversation } from '../../../../shared/workflow-node-conversation'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { WorkflowExecutionTarget } from './WorkflowRunPanel'
import { useWorkflowConversations } from './use-workflow-conversations'
import { WorkflowConversationPicker } from './WorkflowConversationPicker'
import { WorkflowConversationSummary } from './WorkflowConversationSummary'

export function WorkflowNodeConversationFields({
  agent,
  value,
  target,
  onChange
}: {
  agent: TuiAgent
  value?: WorkflowNodeConversation
  target: WorkflowExecutionTarget | null
  onChange(value: WorkflowNodeConversation | undefined): void
}) {
  const history = useWorkflowConversations(agent, target)
  const id = useId()
  const [open, setOpen] = useState(false)
  const mode = value?.mode ?? 'latest'
  const selected =
    value?.mode === 'existing'
      ? history.rows.find((row) => row.key === value.key)
      : history.rows.find((row) => !row.archived)
  return (
    <div className="space-y-3 border-t pt-4">
      <div className="flex items-center justify-between gap-2">
        <span id={`${id}-label`} className="text-sm font-medium">
          {translate('workflows.nodeConversation', 'Conversation')}
        </span>
        <Button
          size="xs"
          variant="ghost"
          disabled={!target || history.busy}
          onClick={history.refresh}
        >
          {translate('workflows.refreshConversations', 'Refresh conversations')}
        </Button>
      </div>
      <RadioGroup
        aria-labelledby={`${id}-label`}
        value={mode}
        onValueChange={(next) => {
          if (next === 'existing') {
            setOpen(true)
          } else {
            onChange(next === 'new' ? { mode: 'new' } : undefined)
          }
        }}
      >
        {[
          {
            mode: 'latest',
            label: translate('workflows.automaticConversation', 'Automatically choose latest')
          },
          { mode: 'new', label: translate('workflows.newConversation', 'New conversation') },
          {
            mode: 'existing',
            label: translate('workflows.specificConversation', 'Choose a past conversation')
          }
        ].map((choice) => (
          <div key={choice.mode} className="flex items-center gap-2">
            <RadioGroupItem
              id={`${id}-${choice.mode}`}
              value={choice.mode}
              disabled={choice.mode === 'existing' && !target}
            />
            <Label htmlFor={`${id}-${choice.mode}`}>{choice.label}</Label>
          </div>
        ))}
      </RadioGroup>
      {mode === 'new' ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'workflows.conversationWillStartNew',
            'This run will create a new conversation.'
          )}
        </p>
      ) : (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-2xs text-muted-foreground">
            {mode === 'existing'
              ? translate('workflows.conversationSelected', 'Selected conversation')
              : translate('workflows.conversationCurrentLatest', 'Currently the latest available')}
          </p>
          {selected ? (
            <WorkflowConversationSummary row={selected} />
          ) : (
            <p className="text-xs text-muted-foreground" role="status">
              {mode === 'existing'
                ? translate(
                    'workflows.selectedConversationMissing',
                    'Selected conversation is unavailable'
                  )
                : history.busy
                  ? translate('workspaceHistory.loading', 'Reading conversation history…')
                  : history.loaded
                    ? translate(
                        'workflows.noAgentConversations',
                        'No resumable conversations for this agent in this workspace. A new conversation will be created.'
                      )
                    : translate(
                        'workflows.selectWorkspace',
                        'Select a workspace in the sidebar to run this workflow.'
                      )}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={!target || history.busy}
              onClick={() => setOpen(true)}
            >
              {translate('workflows.conversationChoose', 'Select conversation')}
            </Button>
            {selected && (
              <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
                {translate('workflows.conversationView', 'View records')}
              </Button>
            )}
          </div>
        </div>
      )}
      <p className="text-2xs text-muted-foreground">
        {translate(
          'workflows.conversationHint',
          'Each run pins this choice. Rework continues this node’s conversation from the current run; the current task and node instructions apply.'
        )}
      </p>
      {history.error && (
        <p role="alert" className="text-xs text-destructive">
          {history.error}
        </p>
      )}
      {open && target && (
        <WorkflowConversationPicker
          key={`${agent}:${target.worktreeId}`}
          agent={agent}
          target={target}
          rows={history.rows}
          initialKey={selected?.key}
          busy={history.busy}
          error={history.error}
          onRefresh={history.refresh}
          onClose={() => setOpen(false)}
          onSelect={(key) => {
            onChange({ mode: 'existing', key })
            setOpen(false)
          }}
        />
      )}
    </div>
  )
}
