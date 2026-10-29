// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useWorkspaceSessionHistory } from './use-workspace-session-history'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
afterEach(() => {
  cleanup()
  rpc.mockReset()
})
const target: RuntimeClientTarget = { kind: 'local' }

it('refreshes an archive change that arrives while the other pane is still loading', async () => {
  let resolveFirst: (value: unknown) => void = () => {}
  rpc
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )
    .mockResolvedValue({ rows: [], total: 0, hasMore: false, issues: [] })
  const { result } = renderHook(() => useWorkspaceSessionHistory('folder:test', target, false))
  await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1))
  act(() =>
    window.dispatchEvent(
      new CustomEvent('workspace-session-history-changed', { detail: 'archive' })
    )
  )
  await act(async () =>
    resolveFirst({
      rows: [
        {
          key: 'a'.repeat(64),
          agent: 'codex',
          title: 'Archived elsewhere',
          archived: false,
          updatedAt: 1,
          source: 'cli'
        }
      ],
      total: 1,
      hasMore: false,
      issues: []
    })
  )
  await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(result.current.rows).toEqual([]))
  expect(rpc.mock.calls[1]?.[2]).toMatchObject({ worktree: 'id:folder:test', force: false })
})
