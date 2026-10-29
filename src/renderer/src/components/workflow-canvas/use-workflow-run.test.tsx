// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkflowRun } from './use-workflow-run'
import { workflowDefinitionSchema } from '../../../../shared/workflow-definition'
import { createWorkflowExecution } from '../../../../shared/workflow-executor'
import type { WorkflowRunSnapshot } from '../../../../shared/workflow-run-contract'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { createUuidV4 } from '../../../../shared/uuid-v4'
import { workflowWorkspaceScope, workflowScopedStorageKey } from './workflow-workspace-scope'

const mock = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mock.call }))
const definition = workflowDefinitionSchema.parse({
  version: 1,
  name: 'Done',
  entry: 'done',
  maxSteps: 1,
  nodes: [{ id: 'done', type: 'end', outcome: 'succeeded' }]
})
function completed(id: string): WorkflowRunSnapshot {
  const execution = createWorkflowExecution(
    definition,
    'Task',
    { worktree: 'id:folder:fixture', from: 'term_coord', target: 'desktop' },
    'runtime'
  )
  execution.runId = 'run_1'
  execution.status = 'succeeded'
  return { id, createdAt: 1, worktree: 'id:folder:fixture', phase: 'succeeded', execution }
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  mock.call.mockReset()
  mock.call.mockImplementation(async (_target, _method, params) => completed(params.id))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('workflow execution client', () => {
  it('keeps run references scoped to the workspace and refuses a mismatched launch', async () => {
    const scope = workflowWorkspaceScope({ kind: 'local' }, 'folder:fixture')
    const otherScope = workflowWorkspaceScope(
      { kind: 'environment', environmentId: 'remote' },
      'folder:fixture'
    )
    const accepted = vi.fn()
    const local = renderHook(() => useWorkflowRun(scope, accepted))
    await act(async () => {
      await local.result.current.start(
        definition,
        'Task',
        { kind: 'local' },
        'folder:fixture',
        'Local'
      )
    })
    expect(accepted).toHaveBeenCalledTimes(1)
    const localId = local.result.current.binding?.id
    expect(localStorage.getItem('orca.workflow-run.v1')).toBeNull()
    expect(localStorage.getItem(workflowScopedStorageKey('orca.workflow-run.v1', scope))).toContain(
      localId
    )
    local.unmount()
    const remote = renderHook(() => useWorkflowRun(otherScope))
    expect(remote.result.current.binding).toBeNull()
    mock.call.mockClear()
    await act(async () => {
      await remote.result.current.start(
        definition,
        'Wrong target',
        { kind: 'local' },
        'folder:fixture',
        'Wrong'
      )
    })
    expect(mock.call).not.toHaveBeenCalled()
    expect(remote.result.current.error).toContain('workspace changed')
    remote.unmount()
    const restored = renderHook(() => useWorkflowRun(scope))
    expect(restored.result.current.binding?.id).toBe(localId)
    restored.unmount()
  })

  it('migrates only a matching legacy run and does not resurrect it after detaching', async () => {
    const binding = {
      id: createUuidV4(),
      target: { kind: 'local' },
      worktreeId: 'folder:fixture',
      workspaceLabel: 'Folder'
    }
    localStorage.setItem('orca.workflow-run.v1', JSON.stringify(binding))
    const other = renderHook(() =>
      useWorkflowRun(workflowWorkspaceScope({ kind: 'local' }, 'other'))
    )
    expect(other.result.current.binding).toBeNull()
    expect(localStorage.getItem('orca.workflow-run.v1')).not.toBeNull()
    other.unmount()
    const scope = workflowWorkspaceScope({ kind: 'local' }, 'folder:fixture')
    const migrated = renderHook(() => useWorkflowRun(scope))
    expect(migrated.result.current.binding?.id).toBe(binding.id)
    expect(localStorage.getItem('orca.workflow-run.v1')).toBeNull()
    await act(async () => {})
    act(() => migrated.result.current.detach())
    migrated.unmount()
    const reopened = renderHook(() => useWorkflowRun(scope))
    expect(reopened.result.current.binding).toBeNull()
    reopened.unmount()
  })

  it('releases a rejected start only after the host confirms that its run was never saved', async () => {
    mock.call.mockImplementation(async (_target, method) => {
      throw new RuntimeRpcCallError({
        id: 'response',
        ok: false,
        error: {
          code: 'runtime_error',
          message:
            method === 'workflow.start'
              ? 'Node develop changed its role or configuration. Start new conversations.'
              : "ENOENT: no such file or directory, open 'C:\\workflow-runs\\new-id\\run.json'"
        }
      })
    })
    const { result, unmount } = renderHook(useWorkflowRun)
    await act(async () => {
      await result.current.start(definition, 'Task', { kind: 'local' }, 'folder:fixture', 'Folder')
    })
    await act(async () => {
      vi.advanceTimersByTime(4000)
    })
    expect(result.current.binding).toBeNull()
    expect(localStorage.getItem('orca.workflow-run.v1')).toBeNull()
    expect(result.current.error).not.toContain('ENOENT')
    expect(result.current.error).toContain('configuration')
    expect(mock.call.mock.calls.filter((call) => call[1] === 'workflow.show')).toHaveLength(1)
    mock.call.mockImplementation(async (_target, _method, params) => completed(params.id))
    await act(async () => {
      await result.current.start(definition, 'Retry', { kind: 'local' }, 'folder:fixture', 'Folder')
    })
    expect(result.current.snapshot?.phase).toBe('succeeded')
    unmount()
  })

  it('retains a saved run after a server start error so it can be recovered', async () => {
    mock.call.mockImplementation(async (_target, method, params) => {
      if (method === 'workflow.start') {
        throw new RuntimeRpcCallError({
          id: 'response',
          ok: false,
          error: { code: 'runtime_error', message: 'Coordinator failed after saving' }
        })
      }
      return completed(params.id)
    })
    const { result, unmount } = renderHook(useWorkflowRun)
    await act(async () => {
      await result.current.start(definition, 'Task', { kind: 'local' }, 'folder:fixture', 'Folder')
    })
    expect(result.current.binding?.id).toBeDefined()
    expect(result.current.snapshot?.id).toBe(result.current.binding?.id)
    expect(localStorage.getItem('orca.workflow-run.v1')).not.toBeNull()
    unmount()
  })

  it('preserves the original start failure and recovery identity when delivery is uncertain', async () => {
    mock.call.mockImplementation(async (_target, method) => {
      throw new Error(
        method === 'workflow.start'
          ? 'Connection lost during start'
          : "ENOENT: open '/runs/new/run.json'"
      )
    })
    const { result, unmount } = renderHook(useWorkflowRun)
    await act(async () => {
      await result.current.start(definition, 'Task', { kind: 'local' }, 'folder:fixture', 'Folder')
    })
    await act(async () => {
      vi.advanceTimersByTime(4000)
    })
    expect(result.current.binding?.id).toBeDefined()
    expect(result.current.error).toContain('Connection lost during start')
    expect(result.current.error).not.toContain('ENOENT')
    unmount()
  })

  it('dispatches one intent for rapid repeated clicks and pins its runtime target', async () => {
    const { result, unmount } = renderHook(useWorkflowRun)
    const target = { kind: 'environment', environmentId: 'host-a' } as const
    await act(async () => {
      await Promise.all([
        result.current.start(definition, 'Task', target, 'folder:fixture', 'Folder A'),
        result.current.start(definition, 'Task', target, 'folder:fixture', 'Folder A')
      ])
    })
    const starts = mock.call.mock.calls.filter((call) => call[1] === 'workflow.start')
    expect(starts).toHaveLength(1)
    expect(starts[0][0]).toEqual(target)
    expect(starts[0][2]).toMatchObject({ input: 'Task', worktree: 'id:folder:fixture', definition })
    expect(result.current.snapshot?.phase).toBe('succeeded')
    expect(result.current.binding?.target).toEqual(target)
    unmount()
  })

  it('restores the run reference after remount and only reads the original host', async () => {
    const first = renderHook(useWorkflowRun)
    await act(async () => {
      await first.result.current.start(
        definition,
        'Task',
        { kind: 'environment', environmentId: 'host-a' },
        'folder:fixture',
        'Folder A'
      )
    })
    const id = first.result.current.binding?.id
    first.unmount()
    mock.call.mockClear()
    const second = renderHook(useWorkflowRun)
    await act(async () => {})
    expect(second.result.current.snapshot?.id).toBe(id)
    expect(mock.call.mock.calls.every((call) => call[1] === 'workflow.show')).toBe(true)
    expect(mock.call.mock.calls[0][0]).toEqual({ kind: 'environment', environmentId: 'host-a' })
    second.unmount()
  })

  it('preserves recovery identity when the host does not support workflow RPC', async () => {
    mock.call.mockRejectedValue(new Error('method_not_found: workflow.start'))
    const { result, unmount } = renderHook(useWorkflowRun)
    await act(async () => {
      await result.current.start(definition, 'Task', { kind: 'local' }, 'folder:fixture', 'Folder')
    })
    expect(result.current.error).toContain('Update the execution host')
    expect(result.current.binding?.id).toBeDefined()
    expect(result.current.snapshot).toBeNull()
    unmount()
  })

  it('refuses to start when its recovery reference cannot be saved', async () => {
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Quota exceeded')
    })
    const { result, unmount } = renderHook(useWorkflowRun)
    await act(async () => {
      await result.current.start(definition, 'Task', { kind: 'local' }, 'folder:fixture', 'Folder')
    })
    expect(mock.call).not.toHaveBeenCalled()
    expect(result.current.error).toContain('Cannot save')
    expect(result.current.binding).toBeNull()
    unmount()
    write.mockRestore()
  })
})
