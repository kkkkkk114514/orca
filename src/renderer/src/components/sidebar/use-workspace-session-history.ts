import { useCallback, useEffect, useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  workspaceSessionListSchema,
  type WorkspaceSessionRow
} from '../../../../shared/workspace-session-history'

export function useWorkspaceSessionHistory(
  worktreeId: string,
  target: RuntimeClientTarget | null,
  archived: boolean
) {
  const [rows, setRows] = useState<WorkspaceSessionRow[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const generation = useRef(0)
  const loadedCount = useRef(0)
  const queuedRefresh = useRef<boolean | null>(null)
  const refresh = useCallback(
    async (offset = 0, force = false): Promise<void> => {
      if (!target || pending.current) {
        return
      }
      const epoch = generation.current
      pending.current = true
      setBusy(true)
      try {
        const page = workspaceSessionListSchema.parse(
          await callRuntimeRpc(target, 'workspaceSessions.list', {
            worktree: `id:${worktreeId}`,
            archived,
            offset,
            force
          })
        )
        if (epoch !== generation.current) {
          return
        }
        setRows((previous) =>
          offset
            ? [...new Map([...previous, ...page.rows].map((row) => [row.key, row])).values()]
            : page.rows
        )
        loadedCount.current = offset + page.rows.length
        setHasMore(page.hasMore)
        setError('')
      } catch (failure) {
        if (epoch === generation.current) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      } finally {
        if (epoch === generation.current) {
          pending.current = false
          setBusy(false)
          if (queuedRefresh.current !== null) {
            const force = queuedRefresh.current
            queuedRefresh.current = null
            void refresh(0, force)
          }
        }
      }
    },
    [worktreeId, target, archived]
  )
  useEffect(() => {
    const epoch = ++generation.current
    pending.current = false
    loadedCount.current = 0
    queuedRefresh.current = null
    setRows([])
    setError('')
    void refresh()
    const timer = setInterval(() => {
      if (!document.hidden && loadedCount.current <= 50) {
        void refresh()
      }
    }, 3_000)
    const changed = (event: Event) => {
      const force = !(event instanceof CustomEvent && event.detail === 'archive')
      if (pending.current) {
        queuedRefresh.current = (queuedRefresh.current ?? false) || force
      } else {
        void refresh(0, force)
      }
    }
    window.addEventListener('workspace-session-history-changed', changed)
    return () => {
      generation.current = epoch + 1
      clearInterval(timer)
      window.removeEventListener('workspace-session-history-changed', changed)
    }
  }, [refresh])
  const archive = async (row: WorkspaceSessionRow) => {
    if (!target || pending.current) {
      return
    }
    const epoch = generation.current
    pending.current = true
    setBusy(true)
    try {
      await callRuntimeRpc(target, 'workspaceSessions.archive', {
        worktree: `id:${worktreeId}`,
        key: row.key,
        archived: !row.archived
      })
      if (epoch === generation.current) {
        setRows((previous) => previous.filter((item) => item.key !== row.key))
        window.dispatchEvent(
          new CustomEvent('workspace-session-history-changed', { detail: 'archive' })
        )
      }
    } catch (failure) {
      if (epoch === generation.current) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    } finally {
      if (epoch === generation.current) {
        pending.current = false
        setBusy(false)
        if (queuedRefresh.current !== null) {
          const force = queuedRefresh.current
          queuedRefresh.current = null
          void refresh(0, force)
        }
      }
    }
  }
  return { rows, hasMore, busy, error, setError, refresh, archive }
}
