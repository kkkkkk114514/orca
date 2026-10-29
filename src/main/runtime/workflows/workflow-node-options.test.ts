import { expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { workflowSecurityCapabilities } from '../../../shared/workflow-node-security'
import { getWorkflowNodeOptions } from './workflow-node-options'
import { readWorkflowCodexModels } from './workflow-codex-models'
vi.mock('./workflow-codex-models', () => ({ readWorkflowCodexModels: vi.fn() }))
vi.mock('./workflow-security-capabilities', () => ({
  codexWorkflowSecurityCapabilities: async () => workflowSecurityCapabilities('codex')
}))

it('preserves Codex permission controls when its model listing is unavailable', async () => {
  vi.mocked(readWorkflowCodexModels).mockRejectedValue(new Error('model listing unsupported'))
  const runtime: Parameters<typeof getWorkflowNodeOptions>[0] = {
    showTerminalWorkspaceLaunchScope: vi
      .fn()
      .mockResolvedValue({ id: 'folder:test', path: '/workspace', connectionId: null }),
    getClientSettings: () => ({
      ...getDefaultSettings('/tmp'),
      hostSettingOverrides: {},
      sourceControlAi: { actions: {} }
    }),
    resolveProjectRuntimeForWorktree: vi.fn(),
    listRepos: () => [],
    resolveSkillDiscoveryProviderRoots: vi.fn()
  }
  const result = await getWorkflowNodeOptions(runtime, {
    agent: 'codex',
    worktree: 'id:folder:test'
  })
  expect(result.models).toEqual([])
  expect(result.warnings).toHaveLength(1)
  expect(result.securityCapabilities).toEqual(workflowSecurityCapabilities('codex'))
})
