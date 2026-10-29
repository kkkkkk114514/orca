import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { WorkspaceSessionAgentGroups } from './WorkspaceSessionAgentGroups'
import { useWorkspaceSessionHistory } from './use-workspace-session-history'
import { openWorkspaceHistorySession } from './workspace-session-history-navigation'

export function WorkspaceSessionHistory({
  worktreeId,
  active
}: {
  worktreeId: string
  active: boolean
}) {
  const host = useAppStore((state) => resolveStructuredAgentSessionOwner(state, worktreeId))
  const target = useMemo(() => structuredAgentSessionTargetForHost(host), [host])
  if (!active || !target) {
    return null
  }
  return (
    <SidebarAgentHistory key={`${host}:${worktreeId}`} worktreeId={worktreeId} target={target} />
  )
}

function SidebarAgentHistory({
  worktreeId,
  target
}: {
  worktreeId: string
  target: RuntimeClientTarget
}) {
  const history = useWorkspaceSessionHistory(worktreeId, target, false)
  return (
    <div onClick={(event) => event.stopPropagation()} data-workspace-session-history={worktreeId}>
      {history.error && (
        <p role="alert" className="px-2 text-xs text-destructive">
          {history.error}
        </p>
      )}
      <WorkspaceSessionAgentGroups
        rows={history.rows}
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
      {history.hasMore && (
        <Button
          size="xs"
          variant="ghost"
          disabled={history.busy}
          onClick={() => {
            void history.refresh(history.rows.length)
          }}
        >
          {translate('workspaceHistory.more', 'Load more conversations')}
        </Button>
      )}
    </div>
  )
}
