import { readFile, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { runProcess } from '@orca/process-host'
import { tokenizeCustomCommandTemplate } from '../../../shared/commit-message-prompt'
import { resolveStructuredAgentCommand } from '../../native-chat/structured-agent-command-resolution'
import {
  workflowHeadlessEnvironment,
  type WorkflowHeadlessAgent,
  type WorkflowHeadlessSettings
} from './workflow-headless-command'

export const object = (value: unknown): Record<string, unknown> =>
  z.record(z.string(), z.unknown()).safeParse(value).data ?? {}

export async function readNodeJson(path: string): Promise<Record<string, unknown>> {
  try {
    return z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {}
    }
    throw new Error(
      'Cannot read the CLI configuration. Check its path, format and access permissions.'
    )
  }
}

export function nodeEnvironment(agent: WorkflowHeadlessAgent, settings: WorkflowHeadlessSettings) {
  return workflowHeadlessEnvironment(agent, settings)
}

export function workflowNodeHome(agent: WorkflowHeadlessAgent, settings: WorkflowHeadlessSettings) {
  const env = nodeEnvironment(agent, settings)
  return (process.platform === 'win32' ? env.USERPROFILE : env.HOME) ?? homedir()
}

export function dshProfile(settings: WorkflowHeadlessSettings, profile?: string) {
  const parsed = tokenizeCustomCommandTemplate(settings.agentDefaultArgs?.dsh ?? '', 'literal')
  if (!parsed.ok) {
    throw new Error('DSH default arguments must be literal arguments.')
  }
  const index = parsed.tokens.indexOf('--profile')
  const value =
    profile ??
    (index !== -1 ? parsed.tokens[index + 1] : undefined) ??
    parsed.tokens.find((token) => token.startsWith('--profile='))?.slice(10) ??
    nodeEnvironment('dsh', settings).ORCA_WORKFLOW_DSH_PROFILE ??
    'default'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error('Choose a DSH profile name, without path separators.')
  }
  return value
}

export async function probeNodeCli(
  agent: WorkflowHeadlessAgent,
  settings: WorkflowHeadlessSettings,
  cwd: string,
  args: string[],
  signal?: AbortSignal
) {
  const env = nodeEnvironment(agent, settings)
  const result = await runProcess(
    {
      program: resolveStructuredAgentCommand(agent, settings, { pathEnv: env.PATH ?? env.Path }),
      args,
      cwd,
      env,
      signal,
      timeoutMs: 30_000,
      maxOutputBytes: 2_000_000,
      terminationBarrier: true
    },
    'tail'
  )
  if (result.code !== 0 || result.timedOut || result.outputTruncated || result.signal) {
    throw new Error(
      `Cannot inspect ${agent} configuration. Verify its command, installation and profile on this execution host.`
    )
  }
  return result.stdout
}

export type DshPlugin = {
  id: string
  name: string
  disabled: boolean
  config: Record<string, unknown>
}

export function readDshPlugins(text: string): DshPlugin[] {
  const tree: unknown = parseYaml(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }]
  })
  const result: DshPlugin[] = []
  const visit = (value: unknown, depth: number) => {
    if (depth > 30) {
      throw new Error('DSH configuration nesting is too deep.')
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1)
      }
      return
    }
    const row = object(value)
    if (typeof row.id === 'string' && typeof row.name === 'string') {
      result.push({
        id: row.id,
        name: row.name,
        disabled: row.disabled === true,
        config: object(row.config)
      })
    }
    for (const child of Object.values(row)) {
      if (typeof child === 'object' && child !== null) {
        visit(child, depth + 1)
      }
    }
  }
  visit(tree, 0)
  return result
}

export async function inspectDsh(
  settings: WorkflowHeadlessSettings,
  cwd: string,
  profile?: string,
  signal?: AbortSignal
) {
  const selected = dshProfile(settings, profile)
  const root = join(
    nodeEnvironment('dsh', settings).DSH_HOME ?? join(workflowNodeHome('dsh', settings), '.dsh'),
    'profiles'
  )
  const profiles = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ id: entry.name, label: entry.name }))
  const plugins = readDshPlugins(
    await probeNodeCli('dsh', settings, cwd, ['--profile', selected, '--dump-config'], signal)
  )
  return { profiles, plugins }
}

export async function zcodeProviderPath(
  settings: WorkflowHeadlessSettings,
  profile?: string,
  cwd = process.cwd()
) {
  const env = nodeEnvironment('zcode', settings)
  const path =
    profile ?? (await zcodeConfigOverride(settings, 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE'))
  return path
    ? path.startsWith('~')
      ? expandNodeHome(path, workflowNodeHome('zcode', settings))
      : resolve(cwd, path)
    : join(
        env.ZCODE_DATA_BASE_DIR ?? workflowNodeHome('zcode', settings),
        '.zcode',
        'v2',
        'provider_config.json'
      )
}

async function zcodeConfigOverride(settings: WorkflowHeadlessSettings, key: string) {
  const env = nodeEnvironment('zcode', settings)
  let path = env[key]
  if (!path) {
    const program = resolveStructuredAgentCommand('zcode', settings, {
      pathEnv: env.PATH ?? env.Path
    })
    if (/\.cmd$/i.test(program)) {
      const wrapper = await readFile(program, 'utf8')
      const relative = new RegExp(`set\\s+"${key}=%~dp0([^"\\r\\n]+)"`, 'i').exec(wrapper)?.[1]
      if (relative && !relative.includes('%')) {
        path = resolve(dirname(program), relative)
      }
    }
  }
  return path
}

export async function readZcodeBuiltinConfig(settings: WorkflowHeadlessSettings, cwd: string) {
  const override = await zcodeConfigOverride(settings, 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE')
  if (override) {
    return readNodeJson(
      override.startsWith('~')
        ? expandNodeHome(override, workflowNodeHome('zcode', settings))
        : resolve(cwd, override)
    )
  }
  const env = nodeEnvironment('zcode', settings)
  const command = resolveStructuredAgentCommand('zcode', settings, {
    pathEnv: env.PATH ?? env.Path
  })
  const directory = dirname(await realpath(command))
  for (const path of [
    join(directory, 'provider', 'zcode-builtin.json'),
    join(directory, 'runtime', 'provider', 'zcode-builtin.json')
  ]) {
    const config = await readNodeJson(path)
    if (Object.keys(config).length) {
      return config
    }
  }
  return {}
}

export function expandNodeHome(path: string, home = homedir()) {
  return path === '~'
    ? home
    : path.startsWith('~/') || path.startsWith('~\\')
      ? resolve(home, path.slice(2))
      : isAbsolute(path)
        ? path
        : resolve(home, path)
}

const zcodePluginSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  rootPath: z.string()
})

export async function inspectZcode(
  settings: WorkflowHeadlessSettings,
  cwd: string,
  profile?: string,
  signal?: AbortSignal
) {
  const providerPath = await zcodeProviderPath(settings, profile, cwd)
  const provider = await readNodeJson(providerPath)
  const user = await readNodeJson(
    join(workflowNodeHome('zcode', settings), '.zcode', 'cli', 'config.json')
  )
  const primary = await readNodeJson(join(cwd, 'zcode.json'))
  const project = Object.keys(primary).length
    ? primary
    : await readNodeJson(join(cwd, '.zcode', 'config.json'))
  const plugins = z
    .array(zcodePluginSchema)
    .parse(
      JSON.parse(await probeNodeCli('zcode', settings, cwd, ['plugins', 'list', '--json'], signal))
    )
  const servers = { ...object(object(project.mcp).servers), ...object(object(user.mcp).servers) }
  return { providerPath, provider, user, project, plugins, servers }
}
