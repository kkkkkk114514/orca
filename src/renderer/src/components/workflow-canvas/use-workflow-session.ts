import { useEffect, useRef, useState } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { WorkflowSessionPage } from '../../../../shared/workflow-session-view'
import { readWorkflowSessionPage } from './workflow-session-client'

export function useWorkflowSession(args: {
  id: string
  nodeId: string
  workspaceId: string
  target: RuntimeClientTarget
  visible: boolean
}) {
  const { id, nodeId, workspaceId, target, visible } = args
  const [dispatchId, setDispatchId] = useState<string>()
  const [page, setPage] = useState<WorkflowSessionPage | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const current = useRef(0)
  const observed = useRef<WorkflowSessionPage | null>(null)
  const cursor = useRef<number | undefined>(undefined)
  useEffect(() => {
    const epoch = ++current.current
    const controller = new AbortController()
    let busy = false
    observed.current = null
    cursor.current = undefined
    setPage(null)
    setLoading(false)
    const refresh = async () => {
      if (busy || !visible) {
        return
      }
      busy = true
      try {
        const next = await readWorkflowSessionPage(
          target,
          { id, nodeId, ...(dispatchId ? { dispatchId } : {}) },
          { signal: controller.signal, workspaceId }
        )
        if (epoch !== current.current || controller.signal.aborted) {
          return
        }
        const previous = observed.current
        const sameVisit =
          previous?.dispatchId === next.dispatchId &&
          previous.source === next.source &&
          previous.cleared === next.cleared
        if (!sameVisit) {
          cursor.current = undefined
        }
        const entries = new Map(
          [...(sameVisit ? previous.entries : []), ...next.entries].map((entry) => [
            entry.id,
            entry
          ])
        )
        const updated = {
          ...next,
          entries: [...entries.values()],
          ...(cursor.current !== undefined
            ? { before: cursor.current, hasMore: cursor.current > 0 }
            : {})
        }
        observed.current = updated
        setPage(updated)
        setError('')
      } catch (failure) {
        if (!controller.signal.aborted && epoch === current.current) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      } finally {
        busy = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => {
      controller.abort()
      clearInterval(timer)
      current.current = epoch + 1
    }
  }, [id, nodeId, workspaceId, target, visible, dispatchId])

  const loadEarlier = async () => {
    if (!page || loading || !page.hasMore) {
      return
    }
    const epoch = current.current
    setLoading(true)
    try {
      const next = await readWorkflowSessionPage(
        target,
        { id, nodeId, dispatchId: page.dispatchId, before: page.before },
        { workspaceId }
      )
      if (epoch !== current.current) {
        return
      }
      const latest = observed.current
      if (!latest || latest.dispatchId !== next.dispatchId || latest.source !== next.source) {
        return
      }
      cursor.current = next.hasMore ? next.before : 0
      const updated = {
        ...latest,
        entries: [
          ...new Map(
            [...next.entries, ...latest.entries].map((entry) => [entry.id, entry])
          ).values()
        ],
        before: next.before,
        hasMore: next.hasMore
      }
      observed.current = updated
      setPage(updated)
    } catch (failure) {
      if (epoch === current.current) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    } finally {
      if (epoch === current.current) {
        setLoading(false)
      }
    }
  }
  return { page, error, loading, loadEarlier, setDispatchId, selectedDispatchId: dispatchId }
}
