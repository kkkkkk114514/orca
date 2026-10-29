import { z } from 'zod'
import { getAgentSessionOptionLaunchCatalog } from '../../../shared/agent-session-option-launch'
import type { WorkflowNodeOptions } from '../../../shared/workflow-node-launch'
import type { OrcaRuntimeService } from '../orca-runtime'
import {
  discoverSkillsOnTarget,
  resolveSkillDiscoveryTarget
} from '../../skills/skill-discovery-target'
import { inspectDsh, inspectZcode, object, readZcodeBuiltinConfig } from './workflow-node-inventory'
import { dshConfiguredModels, zcodeConfiguredModels } from './workflow-node-models'
import { readWorkflowCodexModels } from './workflow-codex-models'
import { workflowSecurityCapabilities } from '../../../shared/workflow-node-security'
import { codexWorkflowSecurityCapabilities } from './workflow-security-capabilities'
import type { WorkflowNodeOptionsParams } from '../../../shared/rpc-contract/workflow-run-params'

type WorkflowNodeOptionsRuntime = Pick<
  OrcaRuntimeService,
  | 'showTerminalWorkspaceLaunchScope'
  | 'getClientSettings'
  | 'resolveProjectRuntimeForWorktree'
  | 'listRepos'
  | 'resolveSkillDiscoveryProviderRoots'
>

export async function discoverWorkflowNodeSkills(
  runtime: WorkflowNodeOptionsRuntime,
  workspace: { id: string; path: string }
) {
  const target = resolveSkillDiscoveryTarget({
    cwd: workspace.path,
    worktreeId: workspace.id,
    projectRuntime: runtime.resolveProjectRuntimeForWorktree(workspace.id)
  })
  if (target.kind !== 'native-host') {
    throw new Error(
      'Native headless node settings require a native host workspace. Select its owning host instead of a WSL workspace.'
    )
  }
  return discoverSkillsOnTarget(target, runtime.listRepos(), {
    providerRootOverrides: await runtime.resolveSkillDiscoveryProviderRoots(target)
  })
}

export async function getWorkflowNodeOptions(
  runtime: WorkflowNodeOptionsRuntime,
  params: z.infer<typeof WorkflowNodeOptionsParams>,
  signal?: AbortSignal
): Promise<WorkflowNodeOptions> {
  const workspace = z
    .object({ id: z.string(), path: z.string(), connectionId: z.string().nullable() })
    .parse(await runtime.showTerminalWorkspaceLaunchScope(params.worktree))
  if (workspace.connectionId !== null) {
    throw new Error('Inspect node settings on the workspace owning host.')
  }
  const result: WorkflowNodeOptions = {
    profiles: [],
    models: [],
    plugins: [],
    mcpServers: [],
    skills: [],
    warnings: [],
    securityCapabilities: workflowSecurityCapabilities(params.agent)
  }
  const settings = runtime.getClientSettings()
  try {
    if (params.agent === 'dsh') {
      const inventory = await inspectDsh(settings, workspace.path, params.profile, signal)
      if (result.securityCapabilities) {
        if (
          !inventory.plugins.some((plugin) => plugin.name === '@deepseek-ai/dsh-sandbox-policy')
        ) {
          result.securityCapabilities.access = []
        }
        if (!inventory.plugins.some((plugin) => plugin.name === '@deepseek-ai/dsh-user-approval')) {
          result.securityCapabilities.approval = []
        }
      }
      result.profiles = inventory.profiles
      result.models = dshConfiguredModels(inventory.plugins)
      for (const plugin of inventory.plugins) {
        const entry = { id: plugin.id, label: plugin.name, enabled: !plugin.disabled }
        if (/mcp/i.test(plugin.name)) {
          result.mcpServers.push(entry)
        } else if (!plugin.name.startsWith('@deepseek-ai/')) {
          result.plugins.push(entry)
        }
      }
    } else if (params.agent === 'zcode') {
      const inventory = await inspectZcode(settings, workspace.path, params.profile, signal)
      result.plugins = inventory.plugins.map((plugin) => ({
        id: plugin.id,
        label: plugin.name,
        enabled: plugin.enabled
      }))
      result.mcpServers = Object.entries(inventory.servers).map(([id, value]) => ({
        id,
        label: id,
        enabled: object(value).enabled !== false
      }))
      const builtin = await readZcodeBuiltinConfig(settings, workspace.path).catch(() => {
        result.warnings.push(
          'Cannot read the installed ZCode model catalog. Only personal configuration is shown.'
        )
        return {}
      })
      result.models = zcodeConfiguredModels(inventory.provider, builtin)
    } else {
      if (params.agent === 'codex') {
        const [capabilities, catalog] = await Promise.all([
          codexWorkflowSecurityCapabilities(settings, workspace.path, signal),
          readWorkflowCodexModels(settings, workspace.path, signal).catch(() => ({
            models: [],
            warnings: ['Cannot read Codex models. Refresh the CLI inventory or enter a model ID.']
          }))
        ])
        result.securityCapabilities = capabilities
        result.models = catalog.models
        result.warnings.push(...catalog.warnings)
      } else {
        result.models =
          getAgentSessionOptionLaunchCatalog(params.agent)?.models.map((model) => ({
            id: model.id,
            label: model.label
          })) ?? []
      }
    }
  } catch {
    result.securityCapabilities = workflowSecurityCapabilities('zcode')
    result.warnings.push(
      'CLI inventory unavailable. Verify installation and configuration on the execution host, then refresh. Selected overrides will be validated again before launch.'
    )
  }
  if (params.agent === 'dsh' || params.agent === 'zcode') {
    try {
      const discovered = await discoverWorkflowNodeSkills(runtime, workspace)
      result.skills = discovered.skills
        .filter((skill) => skill.installed)
        .map((skill) => ({ id: skill.id, label: skill.name, description: skill.description }))
    } catch {
      result.warnings.push(
        'Skills could not be discovered for this workspace on the execution host.'
      )
    }
  }
  return result
}
