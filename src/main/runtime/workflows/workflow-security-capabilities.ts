import { workflowSecurityCapabilities } from '../../../shared/workflow-node-security'
import { applyWorkflowCodexSecurity } from './workflow-codex-security'
import { probeNodeCli } from './workflow-node-inventory'
import type { WorkflowHeadlessSettings } from './workflow-headless-command'
import type { WorkflowNodeSecurity } from '../../../shared/workflow-node-security'

export async function verifyCodexNetworkPolicy(
  settings: WorkflowHeadlessSettings,
  cwd: string,
  security: WorkflowNodeSecurity,
  signal?: AbortSignal
) {
  const args = applyWorkflowCodexSecurity([], security)
  const features = await probeNodeCli('codex', settings, cwd, [...args, 'features', 'list'], signal)
  if (!/^network_proxy\s+(?:experimental|stable|under development)\s+true\s*$/m.test(features)) {
    throw new Error(
      'This Codex CLI cannot enforce the requested network allowlist. Update it on the execution host or choose another network policy.'
    )
  }
}

export async function codexWorkflowSecurityCapabilities(
  settings: WorkflowHeadlessSettings,
  cwd: string,
  signal?: AbortSignal
) {
  const capabilities = workflowSecurityCapabilities('codex')
  try {
    await verifyCodexNetworkPolicy(
      settings,
      cwd,
      {
        access: 'workspace-write',
        approval: 'never',
        network: 'restricted',
        allowedHosts: ['example.com']
      },
      signal
    )
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    capabilities.network = ['allow', 'deny']
  }
  return capabilities
}
