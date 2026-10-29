import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { workspaceSessionPageSchema } from '../../../../shared/workspace-session-history'
import type { z } from 'zod'
import { SessionRecordEntries } from '../workflow-canvas/SessionRecordEntries'

export function WorkspaceSessionHistoryView(props: {
  sessionKey: string
  workspaceId: string
  target: RuntimeClientTarget
  visible: boolean
  title: string
}) {
  const [page, setPage] = useState<z.infer<typeof workspaceSessionPageSchema> | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const pending = useRef(false)
  const first = useRef<number | undefined>(undefined)
  const { sessionKey, workspaceId, target, visible } = props
  const read = async (earlier = false) => {
    if (!visible || pending.current) {
      return
    }
    const epoch = generation.current
    pending.current = true
    setBusy(true)
    try {
      const next = workspaceSessionPageSchema.parse(
        await callRuntimeRpc(target, 'workspaceSessions.read', {
          worktree: `id:${workspaceId}`,
          key: sessionKey,
          ...(earlier && first.current !== undefined ? { before: first.current } : {})
        })
      )
      if (epoch !== generation.current) {
        return
      }
      if (next.row.key !== sessionKey) {
        throw new Error('Conversation identity mismatch')
      }
      if (earlier || first.current === undefined) {
        first.current = next.hasMore ? next.before : 0
      }
      setPage((previous) => ({
        ...next,
        before: first.current ?? next.before,
        hasMore: (first.current ?? 0) > 0,
        entries: [
          ...new Map(
            (earlier
              ? [...next.entries, ...(previous?.entries ?? [])]
              : [...(previous?.entries ?? []), ...next.entries]
            ).map((entry) => [entry.id, entry])
          ).values()
        ]
      }))
      setError('')
    } catch (failure) {
      if (epoch === generation.current) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    } finally {
      if (epoch === generation.current) {
        pending.current = false
        setBusy(false)
      }
    }
  }
  const readRef = useRef(read)
  readRef.current = read
  useEffect(() => {
    const epoch = ++generation.current
    pending.current = false
    first.current = undefined
    setPage(null)
    setError('')
    void readRef.current()
    const timer = setInterval(() => {
      void readRef.current()
    }, 3000)
    return () => {
      generation.current = epoch + 1
      clearInterval(timer)
    }
  }, [sessionKey, workspaceId, target, visible])
  return (
    <section
      className="flex h-full w-full min-h-0 min-w-0 flex-col bg-background text-foreground"
      data-testid="workspace-session-history-view"
    >
      <header className="border-b px-4 py-3">
        <h2 className="truncate text-sm font-medium">{props.title}</h2>
        <p className="text-xs text-muted-foreground">
          {translate(
            'workspaceHistory.readOnly',
            'Read only · viewing does not start or resume the CLI'
          )}
        </p>
      </header>
      {error && (
        <p role="alert" className="px-4 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek px-4 py-3">
        <div className="mx-auto max-w-4xl space-y-3">
          {busy && !page && (
            <p role="status" className="text-xs text-muted-foreground">
              {translate('workspaceHistory.loading', 'Reading conversation history…')}
            </p>
          )}
          {page?.limited && (
            <p role="status" className="text-xs text-muted-foreground">
              {translate(
                'workspaceHistory.limited',
                'This CLI exposes a limited preview here; older or larger records may be unavailable.'
              )}
            </p>
          )}
          {page?.hasMore && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                void read(true)
              }}
            >
              {translate('workflows.sessionEarlier', 'Load earlier records')}
            </Button>
          )}
          {page && <SessionRecordEntries key={sessionKey} entries={page.entries} />}
          {!busy && page?.entries.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {translate(
                'workspaceHistory.noMessages',
                'No readable messages are available for this conversation.'
              )}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
