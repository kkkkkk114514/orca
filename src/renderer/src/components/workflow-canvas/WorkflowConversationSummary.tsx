import { translate } from '@/i18n/i18n'
import type { WorkflowConversationOption } from '../../../../shared/workflow-node-conversation'

export function workflowConversationTitle(row: WorkflowConversationOption) {
  const prefix = row.history?.workflow ? `${row.history.workflow.nodeId} · ` : ''
  return prefix && row.title.startsWith(prefix) ? row.title.slice(prefix.length) : row.title
}

export function WorkflowConversationSummary({ row }: { row: WorkflowConversationOption }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1 text-left">
      <span
        className="line-clamp-2 break-words text-sm font-medium"
        title={workflowConversationTitle(row)}
      >
        {workflowConversationTitle(row)}
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {row.history?.workflow
          ? translate('workflows.conversationNodeSource', 'Workflow node · {{node}}', {
              node: row.history.workflow.nodeId
            })
          : row.history?.source === 'cli'
            ? translate('workflows.conversationCliSource', 'CLI conversation')
            : translate('workflows.nodeConversation', 'Conversation')}
        {row.archived ? ` · ${translate('workflows.archivedConversation', 'Archived')}` : ''}
      </span>
      <span className="text-2xs text-muted-foreground">
        {new Date(row.updatedAt).toLocaleString()}
      </span>
    </span>
  )
}
