import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkflowCanvasDocument } from './workflow-canvas-document'
import { readWorkflowCanvasDraft, saveWorkflowCanvasDraft } from './workflow-canvas-storage'
export { readWorkflowCanvasDraft } from './workflow-canvas-storage'

export function useWorkflowCanvasDocument(scope?: string) {
  const [initial] = useState(() => readWorkflowCanvasDraft(scope))
  const [document, setDocument] = useState(initial.document)
  const [saveState, setSaveState] = useState<'pending' | 'saved' | 'failed'>('pending')
  const [history, setHistory] = useState<{
    past: WorkflowCanvasDocument[]
    future: WorkflowCanvasDocument[]
  }>({ past: [], future: [] })
  const current = useRef(document)
  current.current = document
  const edited = useRef(false)

  useEffect(() => {
    const flush = (): void => {
      try {
        saveWorkflowCanvasDraft(current.current, scope, !scope || edited.current)
      } catch {
        // Keep the in-memory draft available for export if device storage is full.
      }
    }
    window.addEventListener('pagehide', flush)
    window.addEventListener('workflow-canvas-flush', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('workflow-canvas-flush', flush)
      flush()
    }
  }, [scope])

  useEffect(() => {
    setSaveState('pending')
    const timer = setTimeout(() => {
      try {
        saveWorkflowCanvasDraft(document, scope, !scope || edited.current)
        setSaveState('saved')
      } catch {
        setSaveState('failed')
      }
    }, 400)
    return () => clearTimeout(timer)
  }, [document, scope])

  const commit = useCallback((next: WorkflowCanvasDocument, previous = current.current) => {
    edited.current = true
    setHistory((state) => ({ past: [...state.past.slice(-49), previous], future: [] }))
    setDocument(next)
  }, [])

  const undo = (): void => {
    const previous = history.past.at(-1)
    if (!previous) {
      return
    }
    edited.current = true
    setHistory({ past: history.past.slice(0, -1), future: [document, ...history.future] })
    setDocument(previous)
  }

  const redo = (): void => {
    const next = history.future[0]
    if (!next) {
      return
    }
    edited.current = true
    setHistory({ past: [...history.past, document], future: history.future.slice(1) })
    setDocument(next)
  }

  return {
    document,
    setDocument,
    commit,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    saveState,
    recovered: initial.recovered
  }
}
