import { afterEach, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { readWorkflowSessionPage } from './workflow-session-client'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, text: string) => text }))
afterEach(() => vi.resetAllMocks())
const params = { id: '00000000-0000-4000-8000-000000000001', nodeId: 'develop' }
const page = {
  ...params,
  workspaceId: 'folder:project',
  agent: 'dsh',
  dispatchId: 'ctx_actual',
  visits: [{ dispatchId: 'ctx_actual', outcome: 'running' }],
  entries: [],
  source: 'journal',
  before: 0,
  hasMore: false,
  limited: false,
  task: 'Task',
  instructions: 'Develop'
}

it('reads a remote node only on its owning host and never falls back to local', async () => {
  const target = { kind: 'environment', environmentId: 'server-1' } as const
  vi.mocked(callRuntimeRpc).mockResolvedValue(page)
  expect(await readWorkflowSessionPage(target, params, { workspaceId: 'folder:project' })).toEqual(
    page
  )
  expect(callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(target, 'workflow.session', params, {
    signal: undefined,
    suppressFeatureInteraction: true
  })
  vi.mocked(callRuntimeRpc).mockRejectedValue(new Error('Unknown method: workflow.session'))
  await expect(readWorkflowSessionPage(target, params)).rejects.toThrow('Update the execution host')
  expect(vi.mocked(callRuntimeRpc).mock.calls.every(([owner]) => owner === target)).toBe(true)
})

it('rejects a mismatched run, node, workspace or selected visit before displaying records', async () => {
  for (const mismatch of [
    { id: '00000000-0000-4000-8000-000000000002' },
    { nodeId: 'test' },
    { workspaceId: 'folder:other' },
    { dispatchId: 'ctx_other' }
  ]) {
    vi.mocked(callRuntimeRpc).mockResolvedValue({ ...page, ...mismatch })
    await expect(
      readWorkflowSessionPage(
        { kind: 'local' },
        { ...params, dispatchId: 'ctx_actual' },
        { workspaceId: 'folder:project' }
      )
    ).rejects.toThrow('identity mismatch')
  }
})
