// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkflowCanvasDocument } from './use-workflow-canvas-document'
import {
  rememberWorkflowCanvasUsed,
  saveWorkflowCanvasDraft,
  readWorkflowCanvasDraft
} from './workflow-canvas-storage'
import { workflowWorkspaceScope, workflowScopedStorageKey } from './workflow-workspace-scope'
import { createWorkflowCanvasTemplate } from './workflow-canvas-document'

describe('workflow canvas draft lifecycle', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('restores edits, keeps undo/redo and flushes when leaving before the debounce', () => {
    const first = renderHook(useWorkflowCanvasDocument)
    act(() =>
      first.result.current.commit({ ...first.result.current.document, name: 'My workflow' })
    )
    expect(first.result.current.canUndo).toBe(true)
    act(() => first.result.current.undo())
    expect(first.result.current.document.name).not.toBe('My workflow')
    act(() => first.result.current.redo())
    expect(first.result.current.document.name).toBe('My workflow')
    first.unmount()
    const second = renderHook(useWorkflowCanvasDocument)
    expect(second.result.current.document.name).toBe('My workflow')
    second.unmount()
  })

  it('reports storage failure without losing editable state', () => {
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Quota exceeded')
    })
    const { result, unmount } = renderHook(useWorkflowCanvasDocument)
    act(() => {
      result.current.commit({ ...result.current.document, name: 'Keep my edits' })
      vi.advanceTimersByTime(500)
    })
    act(() => vi.advanceTimersByTime(500))
    expect(write).toHaveBeenCalled()
    expect(result.current.saveState).toBe('failed')
    expect(result.current.document.name).toBe('Keep my edits')
    unmount()
    write.mockRestore()
  })

  it('recovers from a corrupt draft with a visible recovery flag', () => {
    localStorage.setItem('orca.workflow-canvas.v1', '{invalid')
    const { result, unmount } = renderHook(useWorkflowCanvasDocument)
    expect(result.current.recovered).toBe(true)
    expect(result.current.document.nodes.length).toBe(4)
    unmount()
  })

  it('restores each workspace draft ahead of unrelated recent workflows and isolates host twins', () => {
    const a = workflowWorkspaceScope({ kind: 'local' }, 'folder:a')
    const b = workflowWorkspaceScope({ kind: 'local' }, 'folder:b')
    const remote = workflowWorkspaceScope(
      { kind: 'environment', environmentId: 'remote' },
      'folder:a'
    )
    const original = { ...createWorkflowCanvasTemplate(), name: 'Latest compiled' }
    saveWorkflowCanvasDraft(original)
    const first = renderHook(() => useWorkflowCanvasDocument(a))
    expect(first.result.current.document.name).toBe('Latest compiled')
    act(() => first.result.current.commit({ ...original, name: 'Workspace A draft' }))
    act(() => window.dispatchEvent(new Event('workflow-canvas-flush')))
    const second = renderHook(() => useWorkflowCanvasDocument(b))
    expect(second.result.current.document.name).toBe('Workspace A draft')
    first.unmount()
    act(() => second.result.current.commit({ ...original, name: 'Workspace B draft' }))
    second.unmount()
    expect(readWorkflowCanvasDraft(a).document.name).toBe('Workspace A draft')
    expect(readWorkflowCanvasDraft(b).document.name).toBe('Workspace B draft')
    expect(readWorkflowCanvasDraft(remote).document.name).toBe('Workspace B draft')
    saveWorkflowCanvasDraft({ ...original, name: 'Remote A' }, remote)
    expect(readWorkflowCanvasDraft(a).document.name).toBe('Workspace A draft')
  })

  it('prefers a workspace last-used workflow and skips invalid global drafts for first use', () => {
    const scope = workflowWorkspaceScope({ kind: 'local' }, 'folder:used')
    const original = { ...createWorkflowCanvasTemplate(), name: 'Used here' }
    rememberWorkflowCanvasUsed(scope, original)
    saveWorkflowCanvasDraft({ ...original, name: 'Edited elsewhere' })
    expect(readWorkflowCanvasDraft(scope).document.name).toBe('Used here')
    const untouched = renderHook(() => useWorkflowCanvasDocument(scope))
    untouched.unmount()
    expect(readWorkflowCanvasDraft('brand-new-workspace').document.name).toBe('Edited elsewhere')
    const invalid = { ...original, name: 'Incomplete', entry: 'missing' }
    saveWorkflowCanvasDraft(invalid)
    expect(readWorkflowCanvasDraft('new-scope').document.name).toBe('Edited elsewhere')
    localStorage.setItem(workflowScopedStorageKey('orca.workflow-canvas.v1', scope), '{broken')
    expect(readWorkflowCanvasDraft(scope)).toMatchObject({
      document: { name: 'Used here' },
      recovered: true
    })
  })
})
