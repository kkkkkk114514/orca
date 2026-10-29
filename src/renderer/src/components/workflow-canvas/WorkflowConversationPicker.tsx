import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { translate } from '@/i18n/i18n'
import { getAgentLabel } from '@/lib/agent-catalog'
import { AgentTypeIcon } from '@/lib/agent-type-icon'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { WorkflowConversationOption } from '../../../../shared/workflow-node-conversation'
import type { WorkflowExecutionTarget } from './WorkflowRunPanel'
import {
  WorkflowConversationSummary,
  workflowConversationTitle
} from './WorkflowConversationSummary'
import { WorkflowSessionView } from './WorkflowSessionView'
import { WorkspaceSessionHistoryView } from '../sidebar/WorkspaceSessionHistoryView'

export function WorkflowConversationPicker({
  agent,
  target,
  rows,
  initialKey,
  busy,
  error,
  onRefresh,
  onClose,
  onSelect
}: {
  agent: TuiAgent
  target: WorkflowExecutionTarget
  rows: WorkflowConversationOption[]
  initialKey?: string
  busy: boolean
  error: string
  onRefresh(): void
  onClose(): void
  onSelect(key: string): void
}) {
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(
    Boolean(rows.find((row) => row.key === initialKey)?.archived)
  )
  const [candidate, setCandidate] = useState(initialKey)
  const normalized = query.trim().toLocaleLowerCase()
  const matches = rows.filter(
    (row) =>
      row.archived === archived &&
      `${row.title} ${row.history?.workflow?.nodeId ?? ''}`.toLocaleLowerCase().includes(normalized)
  )
  const selected = matches.find((row) => row.key === candidate)
  const source = selected?.history
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent className="flex h-[min(44rem,85dvh)] min-w-0 flex-col overflow-hidden sm:max-w-5xl">
        <div className="shrink-0 pr-6">
          <DialogHeader>
            <DialogTitle>
              {translate('workflows.conversationPickerTitle', 'Select a past conversation')}
            </DialogTitle>
            <DialogDescription className="break-words">
              {target.label} · {getAgentLabel(agent)}
            </DialogDescription>
          </DialogHeader>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Input
            className="min-w-0 flex-1 basis-full sm:basis-0"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={translate('workflows.conversationSearch', 'Search conversations')}
            placeholder={translate('workflows.conversationSearch', 'Search conversations')}
          />
          <Button variant="outline" size="sm" disabled={busy} onClick={onRefresh}>
            {translate('workflows.refreshConversations', 'Refresh conversations')}
          </Button>
          <Tabs
            value={archived ? 'archived' : 'recent'}
            onValueChange={(value) => setArchived(value === 'archived')}
          >
            <TabsList>
              <TabsTrigger value="recent">
                {translate('workspaceHistory.recent', 'Recent')}
              </TabsTrigger>
              <TabsTrigger value="archived">
                {translate('workspaceHistory.archived', 'Archived')}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="grid min-h-0 flex-1 grid-rows-2 overflow-hidden rounded-md border md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:grid-rows-1">
          <section
            className="min-h-0 min-w-0 overflow-y-auto scrollbar-sleek border-b p-2 md:border-r md:border-b-0"
            aria-label={translate('workflows.conversationResults', 'Available conversations')}
          >
            {busy ? (
              <p role="status" className="p-3 text-xs text-muted-foreground">
                {translate('workspaceHistory.loading', 'Reading conversation history…')}
              </p>
            ) : matches.length ? (
              matches.map((row) => (
                <Button
                  key={row.key}
                  variant={candidate === row.key ? 'secondary' : 'ghost'}
                  className="h-auto w-full min-w-0 justify-start whitespace-normal"
                  aria-pressed={candidate === row.key}
                  data-current={candidate === row.key}
                  onClick={() => setCandidate(row.key)}
                >
                  <span className="flex w-full min-w-0 items-start gap-3 py-1">
                    <AgentTypeIcon agentType={agent} size={16} />
                    <WorkflowConversationSummary row={row} />
                  </span>
                </Button>
              ))
            ) : (
              <p role="status" className="p-3 text-xs text-muted-foreground">
                {translate('workflows.conversationNoMatches', 'No conversations match this view.')}
              </p>
            )}
          </section>
          <section
            className="flex min-h-0 min-w-0 flex-col overflow-hidden"
            aria-label={translate('workflows.conversationPreview', 'Conversation preview')}
          >
            {selected && source ? (
              source.workflow ? (
                <WorkflowSessionView
                  key={source.key}
                  id={source.workflow.id}
                  nodeId={source.workflow.nodeId}
                  workspaceId={target.worktreeId}
                  target={target.target}
                  visible
                  title={workflowConversationTitle(selected)}
                />
              ) : (
                <WorkspaceSessionHistoryView
                  key={source.key}
                  sessionKey={source.key}
                  workspaceId={target.worktreeId}
                  target={target.target}
                  visible
                  title={workflowConversationTitle(selected)}
                />
              )
            ) : (
              <p className="p-4 text-xs text-muted-foreground">
                {selected
                  ? translate(
                      'workflows.conversationPreviewUnavailable',
                      'Preview is unavailable on this host version. Refresh after updating the host.'
                    )
                  : translate(
                      'workflows.conversationPreviewHint',
                      'Select a conversation to preview its task and records. Your node settings change only after confirmation.'
                    )}
              </p>
            )}
          </section>
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={onClose}>
            {translate('workflows.conversationCancel', 'Cancel')}
          </Button>
          <Button
            disabled={busy || !selected}
            onClick={() => {
              if (selected) {
                onSelect(selected.key)
              }
            }}
          >
            {translate('workflows.conversationUse', 'Use this conversation')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
