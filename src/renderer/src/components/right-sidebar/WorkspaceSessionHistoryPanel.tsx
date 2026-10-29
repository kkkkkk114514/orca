import { groupWorkspaceSessionHistory } from '../sidebar/workspace-session-agent-groups'
import { useMemo, useState } from 'react'
import { History, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { WorkspaceSessionAgentGroups } from '../sidebar/WorkspaceSessionAgentGroups'
import { useWorkspaceSessionHistory } from '../sidebar/use-workspace-session-history'
import { openWorkspaceHistorySession } from '../sidebar/workspace-session-history-navigation'

export default function WorkspaceSessionHistoryPanel() {
  const worktreeId = useAppStore((state) => state.activeWorktreeId)
  const owner = useAppStore((state) =>
    worktreeId ? resolveStructuredAgentSessionOwner(state, worktreeId) : null
  )
  const target = useMemo(() => structuredAgentSessionTargetForHost(owner), [owner])
  if (!worktreeId || !target) {
    return (
      <p className="p-3 text-xs text-muted-foreground">
        {translate(
          'workspaceHistory.hostUnavailable',
          'Select the workspace host to read its history.'
        )}
      </p>
    )
  }
  return (
    <WorkspaceHistoryManager
      key={`${owner}:${worktreeId}`}
      worktreeId={worktreeId}
      target={target}
    />
  )
}

function WorkspaceHistoryManager({
  worktreeId,
  target
}: {
  worktreeId: string
  target: RuntimeClientTarget
}) {
  const [archived, setArchived] = useState(false)
  const [query, setQuery] = useState('')
  const history = useWorkspaceSessionHistory(worktreeId, target, archived)
  const hasMatches = groupWorkspaceSessionHistory(history.rows, query).length > 0
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      data-workspace-session-history-panel={worktreeId}
    >
      <header className="space-y-2 border-b p-3">
        <div className="flex items-center gap-2">
          <History className="size-4 text-muted-foreground" />
          <h2 className="min-w-0 flex-1 text-sm font-medium">
            {translate('workspaceHistory.title', 'Conversations')}
          </h2>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={history.busy}
            aria-label={translate('workspaceHistory.refresh', 'Refresh conversations')}
            onClick={() => {
              void history.refresh(0, true)
            }}
          >
            <RefreshCw />
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="xs"
            variant={archived ? 'ghost' : 'secondary'}
            aria-pressed={!archived}
            onClick={() => setArchived(false)}
          >
            {translate('workspaceHistory.recent', 'Recent')}
          </Button>
          <Button
            size="xs"
            variant={archived ? 'secondary' : 'ghost'}
            aria-pressed={archived}
            onClick={() => setArchived(true)}
          >
            {translate('workspaceHistory.archived', 'Archived')}
          </Button>
        </div>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={translate('workspaceHistory.filter', 'Filter loaded conversations')}
          aria-label={translate('workspaceHistory.filter', 'Filter loaded conversations')}
        />
      </header>
      <div
        className="min-h-0 flex-1 space-y-1 overflow-y-auto scrollbar-sleek p-2"
        aria-busy={history.busy}
      >
        {history.error && (
          <p role="alert" className="break-words text-xs text-destructive">
            {history.error}
          </p>
        )}
        {history.busy && !history.rows.length && (
          <p role="status" className="text-xs text-muted-foreground">
            {translate('workspaceHistory.loading', 'Reading conversation history…')}
          </p>
        )}
        <WorkspaceSessionAgentGroups
          key={String(archived)}
          rows={history.rows}
          query={query}
          defaultExpanded
          busy={history.busy}
          onOpen={(row) => {
            void openWorkspaceHistorySession({ row, target, worktreeId }).catch((error) =>
              history.setError(error instanceof Error ? error.message : String(error))
            )
          }}
          onArchive={(row) => {
            void history.archive(row)
          }}
        />
        {!history.busy && !hasMatches && (
          <p className="text-xs text-muted-foreground">
            {translate('workspaceHistory.empty', 'No conversations in this view.')}
          </p>
        )}
        {history.hasMore && (
          <Button
            variant="ghost"
            size="xs"
            disabled={history.busy}
            onClick={() => {
              void history.refresh(history.rows.length)
            }}
          >
            {translate('workspaceHistory.more', 'Load more conversations')}
          </Button>
        )}
      </div>
    </section>
  )
}
