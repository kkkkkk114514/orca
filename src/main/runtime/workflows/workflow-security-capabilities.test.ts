import { expect, it, vi } from 'vitest'
import {
  verifyCodexNetworkPolicy,
  codexWorkflowSecurityCapabilities
} from './workflow-security-capabilities'
import { probeNodeCli } from './workflow-node-inventory'

vi.mock('./workflow-node-inventory', () => ({ probeNodeCli: vi.fn() }))

it('requires proxy activation under the requested config instead of trusting a feature name alone', async () => {
  const settings = { agentCmdOverrides: {}, agentDefaultArgs: {}, agentDefaultEnv: {} }
  vi.mocked(probeNodeCli).mockResolvedValueOnce('network_proxy experimental false\n')
  await expect(
    verifyCodexNetworkPolicy(settings, '/project', {
      access: 'workspace-write',
      network: 'restricted',
      allowedHosts: ['example.com']
    })
  ).rejects.toThrow('cannot enforce')
  vi.mocked(probeNodeCli).mockRejectedValueOnce(
    new Error('Old CLI cannot parse network proxy table')
  )
  expect((await codexWorkflowSecurityCapabilities(settings, '/project')).network).toEqual([
    'allow',
    'deny'
  ])
  vi.mocked(probeNodeCli).mockResolvedValueOnce('network_proxy experimental true\n')
  expect((await codexWorkflowSecurityCapabilities(settings, '/project')).network).toContain(
    'restricted'
  )
  expect(vi.mocked(probeNodeCli).mock.lastCall?.[3]).toEqual(
    expect.arrayContaining([
      'features.network_proxy={ enabled = true, domains = { "example.com" = "allow" } }',
      'features',
      'list'
    ])
  )
})
