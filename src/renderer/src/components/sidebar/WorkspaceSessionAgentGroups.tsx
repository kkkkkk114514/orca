import { useState } from 'react'
import { Archive, ArchiveRestore, ChevronDown, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentTypeIcon } from '@/lib/agent-type-icon'
import { getAgentLabel } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { workflowSessionViewId } from '../../../../shared/workflow-session-view'
import type { WorkspaceSessionRow } from '../../../../shared/workspace-session-history'
import {
  groupWorkspaceSessionHistory,
  workspaceSessionDisplayTitle
} from './workspace-session-agent-groups'

export function WorkspaceSessionAgentGroups({
  rows,
  query,
  defaultExpanded = false,
  busy,
  onOpen,
  onArchive
}: {
  rows: WorkspaceSessionRow[]
  query?: string
  defaultExpanded?: boolean
  busy: boolean
  onOpen(row: WorkspaceSessionRow): void
  onArchive(row: WorkspaceSessionRow): void
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  return groupWorkspaceSessionHistory(rows, query).map(({ agent, sessions }) => {
    const open = expanded[agent] ?? defaultExpanded
    return (
      <div key={agent} data-session-agent-group={agent}>
        <Button
          variant="sidebar"
          size="sm"
          className="w-full justify-start"
          aria-expanded={open}
          onClick={() => setExpanded((previous) => ({ ...previous, [agent]: !open }))}
        >
          <AgentTypeIcon agentType={agent} />
          <span className="flex-1 text-left text-xs">{getAgentLabel(agent)}</span>
          <span className="text-2xs text-muted-foreground">{sessions.length}</span>
          <ChevronDown className={open ? 'size-3' : 'size-3 -rotate-90'} />
        </Button>
        {open && (
          <div className="pl-3">
            {sessions.map((row) => (
              <div
                key={row.key}
                className="group/session-row flex min-w-0 items-center gap-1"
                data-session-history-row={row.key}
              >
                <Button
                  variant="sidebar"
                  size="sm"
                  className="min-w-0 flex-1 justify-start"
                  title={row.title}
                  data-workflow-session-row={
                    row.workflow
                      ? workflowSessionViewId(row.workflow.id, row.workflow.nodeId)
                      : undefined
                  }
                  onClick={() => onOpen(row)}
                >
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-xs">
                      {workspaceSessionDisplayTitle(row)}
                    </span>
                    <span className="block text-2xs text-muted-foreground">
                      {new Date(row.updatedAt).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </span>
                  </span>
                </Button>
                {row.running && (
                  <span
                    role="status"
                    aria-label={translate('workflows.sessionRunning', 'Agent running')}
                  >
                    <LoaderCircle
                      className="size-3.5 shrink-0 motion-safe:animate-spin"
                      aria-hidden="true"
                    />
                  </span>
                )}
                <span
                  data-session-row-actions
                  className="inline-flex shrink-0 opacity-0 pointer-events-none group-hover/session-row:opacity-100 group-hover/session-row:pointer-events-auto group-focus-within/session-row:opacity-100 group-focus-within/session-row:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto"
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={busy}
                        aria-label={
                          row.archived
                            ? translate('workspaceHistory.restore', 'Restore conversation')
                            : translate('workspaceHistory.archive', 'Archive conversation')
                        }
                        onClick={() => onArchive(row)}
                      >
                        {row.archived ? <ArchiveRestore /> : <Archive />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {row.archived
                        ? translate('workspaceHistory.restore', 'Restore conversation')
                        : translate('workspaceHistory.archive', 'Archive conversation')}
                    </TooltipContent>
                  </Tooltip>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  })
}
