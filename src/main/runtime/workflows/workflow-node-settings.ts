import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeSecureJsonFile } from '../../../shared/secure-file'
import {
  workflowNodeLaunchSchema,
  workflowPermissionChoices,
  type WorkflowNodeLaunch
} from '../../../shared/workflow-node-launch'
import type { WorkflowHeadlessSettings } from './workflow-headless-command'
import { workflowNodeSecurityIssue } from '../../../shared/workflow-node-security'
import {
  expandNodeHome,
  inspectDsh,
  inspectZcode,
  nodeEnvironment,
  object,
  workflowNodeHome
} from './workflow-node-inventory'

export async function prepareWorkflowNodeSettings(args: {
  agent: 'dsh' | 'zcode'
  settings: WorkflowHeadlessSettings
  cwd: string
  root: string
  launch?: WorkflowNodeLaunch
  signal?: AbortSignal
}) {
  const launch = workflowNodeLaunchSchema.parse(args.launch ?? {})
  if (launch.permission && !workflowPermissionChoices(args.agent).includes(launch.permission)) {
    throw new Error('Unsupported node permission mode.')
  }
  if (launch.security) {
    const issue = launch.permission
      ? 'Choose independent permissions or a legacy CLI mode, not both.'
      : workflowNodeSecurityIssue(args.agent, launch.security)
    if (issue) {
      throw new Error(issue)
    }
  }
  let directory: string | undefined
  const cleanup = async () => {
    if (directory) {
      await rm(directory, { recursive: true, force: true })
    }
  }
  const file = async (name: string, value: unknown) => {
    if (!directory) {
      await mkdir(args.root, { recursive: true, mode: 0o700 })
      directory = await mkdtemp(join(args.root, 'node-'))
    }
    const path = join(directory, name)
    if (!writeSecureJsonFile(path, value)) {
      throw new Error('Cannot secure the temporary CLI configuration; node launch was stopped.')
    }
    return path
  }
  const environment: NodeJS.ProcessEnv = {}
  try {
    if (args.agent === 'dsh') {
      const mode =
        launch.security?.access === 'full-access'
          ? 'danger-full-access'
          : (launch.security?.access ?? launch.permission)
      if (mode) {
        environment.DSH_PERMISSION_MODE = mode
      }
      let patch: string | undefined
      if (
        launch.permission ||
        launch.security?.access ||
        launch.security?.approval ||
        launch.model ||
        launch.provider ||
        launch.effort ||
        launch.plugins?.length ||
        launch.mcpServers?.length
      ) {
        const inventory = await inspectDsh(args.settings, args.cwd, launch.profile, args.signal)
        const patches: unknown[] = []
        if (launch.permission) {
          const sandbox = inventory.plugins.find(
            (plugin) => plugin.name === '@deepseek-ai/dsh-sandbox-policy'
          )
          const approval = inventory.plugins.find(
            (plugin) => plugin.name === '@deepseek-ai/dsh-user-approval'
          )
          if (!sandbox || !approval) {
            throw new Error('This DSH profile cannot apply both sandbox and approval settings.')
          }
          patches.push(
            { id: sandbox.id, config: { mode: launch.permission, workspaceRoot: args.cwd } },
            {
              id: approval.id,
              config: { policy: launch.permission === 'danger-full-access' ? 'never' : 'ask' }
            }
          )
        }
        if (launch.security?.access) {
          const sandbox = inventory.plugins.find(
            (plugin) => plugin.name === '@deepseek-ai/dsh-sandbox-policy'
          )
          if (!sandbox) {
            throw new Error('This DSH profile has no sandbox policy plugin.')
          }
          patches.push({
            id: sandbox.id,
            disabled: false,
            config: { mode, workspaceRoot: args.cwd }
          })
        }
        if (launch.security?.approval) {
          const approval = inventory.plugins.find(
            (plugin) => plugin.name === '@deepseek-ai/dsh-user-approval'
          )
          if (!approval) {
            throw new Error('This DSH profile has no approval policy plugin.')
          }
          patches.push({
            id: approval.id,
            disabled: false,
            config: { policy: launch.security.approval === 'never' ? 'never' : 'ask' }
          })
        }
        if (launch.model || launch.provider || launch.effort) {
          const model = inventory.plugins.find(
            (plugin) => plugin.name === '@deepseek-ai/dsh-agent-default-model'
          )
          if (!model) {
            throw new Error('This DSH profile has no supported default-model plugin.')
          }
          patches.push({
            id: model.id,
            config: {
              ...(launch.model ? { model: launch.model } : {}),
              ...(launch.provider ? { provider: launch.provider } : {}),
              ...(launch.effort ? { reasoningEffort: launch.effort } : {})
            }
          })
        }
        for (const id of new Set([...(launch.plugins ?? []), ...(launch.mcpServers ?? [])])) {
          if (!inventory.plugins.some((plugin) => plugin.id === id)) {
            throw new Error(`Selected DSH extension is no longer installed: ${id}`)
          }
          patches.push({ id, disabled: false })
        }
        patch = await file('dsh.patch.json', patches)
      }
      return { environment, patch, cleanup }
    }
    if (
      launch.profile ||
      launch.provider ||
      launch.model ||
      launch.effort ||
      launch.plugins?.length ||
      launch.mcpServers?.length
    ) {
      const inventory = await inspectZcode(args.settings, args.cwd, launch.profile, args.signal)
      environment.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = inventory.providerPath
      if (launch.model || launch.provider || launch.effort) {
        const config = object(inventory.provider.config)
        const current = object(config.defaultModelSelection)
        const selection = {
          ...current,
          ...(launch.provider ? { providerId: launch.provider } : {}),
          ...(launch.model ? { modelId: launch.model } : {}),
          ...(launch.effort
            ? { options: { ...object(current.options), reasoningLevel: launch.effort } }
            : {})
        }
        if (typeof selection.providerId !== 'string' || typeof selection.modelId !== 'string') {
          throw new Error(
            'Choose a ZCode provider and model, or configure its existing default model first.'
          )
        }
        environment.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = await file('zcode-provider.json', {
          ...inventory.provider,
          config: { ...config, defaultModelSelection: selection }
        })
      }
      if (launch.plugins?.length || launch.mcpServers?.length) {
        const userPlugins = object(inventory.user.plugins)
        const home = workflowNodeHome('zcode', args.settings)
        const inheritedEnvironment = nodeEnvironment('zcode', args.settings)
        const projectPlugins = object(inventory.project.plugins)
        const projectFeatures = object(inventory.project.features)
        if (
          (launch.plugins?.length && projectPlugins.enabled === false) ||
          (launch.mcpServers?.length && projectFeatures.mcp === false)
        ) {
          throw new Error(
            'Project configuration disables the selected CLI extensions. Enable them in project configuration before running this node.'
          )
        }
        const selectedPlugins = (launch.plugins ?? []).map((id) => {
          const plugin = inventory.plugins.find((item) => item.id === id)
          if (!plugin) {
            throw new Error(`Selected ZCode plugin is no longer installed: ${id}`)
          }
          if (object(projectPlugins.enabledPlugins)[id] === false) {
            throw new Error(`Project configuration disables ZCode plugin: ${id}`)
          }
          return plugin
        })
        const selectedServers = Object.fromEntries(
          (launch.mcpServers ?? []).map((id) => {
            if (!inventory.servers[id]) {
              throw new Error(`Selected ZCode MCP server is no longer configured: ${id}`)
            }
            return [id, { ...object(inventory.servers[id]), enabled: true }]
          })
        )
        const storage = { ...object(inventory.user.storage), ...object(inventory.project.storage) }
        const originalStorage = expandNodeHome(
          typeof storage.dir === 'string' ? storage.dir : '~/.zcode',
          home
        )
        const enabledPlugins = {
          ...object(userPlugins.enabledPlugins),
          ...Object.fromEntries(selectedPlugins.map((plugin) => [plugin.id, true]))
        }
        const dirs = Array.isArray(userPlugins.dirs)
          ? userPlugins.dirs
              .filter((value): value is string => typeof value === 'string')
              .map((value) => expandNodeHome(value, home))
          : []
        const skills = object(inventory.user.skills)
        const roots = Array.isArray(skills.roots)
          ? skills.roots
              .filter((value): value is string => typeof value === 'string')
              .map((value) => expandNodeHome(value, home))
          : []
        const configPath = await file(join('home', '.zcode', 'cli', 'config.json'), {
          ...inventory.user,
          storage: {
            ...storage,
            dir: originalStorage,
            sessionDbPath: expandNodeHome(
              typeof storage.sessionDbPath === 'string'
                ? storage.sessionDbPath
                : '~/.zcode/cli/db/db.sqlite',
              home
            )
          },
          skills: { ...skills, roots },
          plugins: {
            ...userPlugins,
            ...(selectedPlugins.length ? { enabled: true } : {}),
            dirs: [...new Set([...dirs, ...selectedPlugins.map((plugin) => plugin.rootPath)])],
            enabledPlugins
          },
          features: {
            ...object(inventory.user.features),
            ...(launch.mcpServers?.length ? { mcp: true } : {})
          },
          mcp: {
            ...object(inventory.user.mcp),
            servers: { ...object(object(inventory.user.mcp).servers), ...selectedServers }
          }
        })
        environment.HOME = dirname(dirname(dirname(configPath)))
        environment.USERPROFILE = environment.HOME
        environment.ZCODE_DATA_BASE_DIR = inheritedEnvironment.ZCODE_DATA_BASE_DIR ?? home
        environment.ZCODE_STORAGE_DIR = inheritedEnvironment.ZCODE_STORAGE_DIR ?? originalStorage
      }
    }
    return { environment, patch: undefined, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}
