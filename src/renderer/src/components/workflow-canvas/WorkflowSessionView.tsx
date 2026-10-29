import { SessionRecordEntries } from './SessionRecordEntries'
import { useEffect, useRef, useState } from 'react'
import { LockKeyhole, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { AgentTypeIcon } from '@/lib/agent-type-icon'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useWorkflowSession } from './use-workflow-session'
import { useAppStore } from '@/store'
import { WorkflowSessionComposer } from './WorkflowSessionComposer'

export function WorkflowSessionView(props: {
  title: string
  id: string
  nodeId: string
  workspaceId: string
  target: RuntimeClientTarget
  visible: boolean
  interactive?: boolean
}) {
  const { page, error, loading, loadEarlier, setDispatchId, selectedDispatchId } =
    useWorkflowSession(props)
  const bottom = useRef<HTMLDivElement>(null)
  const chatEnabled = useAppStore((state) => state.settings?.experimentalNativeChat === true)
  const editable = Boolean(props.interactive && chatEnabled && page?.control)
  const [follow, setFollow] = useState(true)
  const lastEntryId = page?.entries.at(-1)?.id
  useEffect(() => {
    window.dispatchEvent(new Event('workspace-session-history-changed'))
  }, [page?.report, page?.control?.paused])
  useEffect(() => {
    if (follow) {
      bottom.current?.scrollIntoView({ block: 'end' })
    }
  }, [lastEntryId, page?.dispatchId, page?.report, follow])
  return (
    <section
      className="flex h-full w-full min-h-0 min-w-0 flex-col bg-background text-foreground"
      data-testid="workflow-session-view"
    >
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        {page ? (
          <AgentTypeIcon agentType={page.agent} size={16} />
        ) : (
          <MessageSquare className="size-4" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={props.nodeId}>
          {props.title}
        </span>
        {!editable && <LockKeyhole className="size-3.5 text-muted-foreground" />}
        <span className="text-xs text-muted-foreground">
          {editable
            ? translate('workflows.sessionManaged', 'Managed by workflow')
            : translate('workflows.sessionReadOnly', 'Read only · managed by workflow')}
        </span>
        {page && (
          <Select
            value={selectedDispatchId ?? 'latest'}
            onValueChange={(value) => setDispatchId(value === 'latest' ? undefined : value)}
          >
            <SelectTrigger
              size="sm"
              className="max-w-full"
              aria-label={translate('workflows.sessionVisit', 'Execution visit')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="latest">
                {translate('workflows.sessionLatest', 'Latest visit (live)')}
              </SelectItem>
              {page.visits.map((visit, index) => (
                <SelectItem key={visit.dispatchId} value={visit.dispatchId}>
                  {index + 1} · {visit.dispatchId} · {visit.outcome}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </header>
      {error && (
        <p role="alert" className="border-b px-4 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {page?.cleared && (
        <p role="status" className="border-b px-4 py-2 text-xs text-muted-foreground">
          {translate(
            'workflows.logsCleared',
            'Public logs were cleared. Accepted reports and CLI conversations are retained.'
          )}
        </p>
      )}
      <div
        className="min-h-0 flex-1 overflow-auto scrollbar-sleek px-4 py-3"
        onScroll={(event) => {
          const el = event.currentTarget
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 64)
        }}
      >
        {!page ? (
          <p role="status" className="text-xs text-muted-foreground">
            {translate('workflows.sessionLoading', 'Loading workflow records…')}
          </p>
        ) : (
          <div className="mx-auto max-w-4xl space-y-3">
            <details className="rounded-md border p-3 text-xs">
              <summary className="cursor-pointer font-medium">
                {translate('workflows.sessionContext', 'Task and node instructions')}
              </summary>
              <pre className="mt-2 whitespace-pre-wrap break-words font-sans">
                {page.task}
                {'\n\n'}
                {page.instructions}
              </pre>
            </details>
            {(page.limited || page.source === 'unavailable') && (
              <p className="text-xs text-muted-foreground" role="status">
                {translate(
                  'workflows.sessionLimited',
                  'Only the available records are shown. Earlier output may be unavailable or exceed the recording limit.'
                )}
              </p>
            )}
            <p className="text-2xs text-muted-foreground">
              {translate(
                'workflows.sessionRecords',
                'Public output and tool activity · refreshes every 2 seconds'
              )}
            </p>
            {page.hasMore && (
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => void loadEarlier()}
              >
                {translate('workflows.sessionEarlier', 'Load earlier records')}
              </Button>
            )}
            <SessionRecordEntries
              key={page.dispatchId}
              entries={page.entries}
              working={page.visits.some(
                (visit) => visit.dispatchId === page.dispatchId && visit.outcome === 'running'
              )}
            />
            {page.report && (
              <details className="rounded-md border bg-muted/30 p-3 text-xs" open>
                <summary className="cursor-pointer font-medium">
                  {translate('workflows.sessionReport', 'Accepted workflow report')}
                </summary>
                <pre className="mt-2 whitespace-pre-wrap break-words font-sans">{page.report}</pre>
              </details>
            )}
          </div>
        )}
        <div ref={bottom} />
      </div>
      {editable && page && (
        <WorkflowSessionComposer key={page.dispatchId} page={page} target={props.target} />
      )}
    </section>
  )
}
