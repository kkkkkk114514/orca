import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareWorkflowNodeSettings } from './workflow-node-settings'
import { buildWorkflowHeadlessCommand } from './workflow-headless-command'
import { inspectDsh, inspectZcode } from './workflow-node-inventory'
import { writeSecureJsonFile } from '../../../shared/secure-file'
import type * as NodeInventory from './workflow-node-inventory'

vi.mock('./workflow-node-inventory', async (original) => ({
  ...(await original<typeof NodeInventory>()),
  inspectDsh: vi.fn(),
  inspectZcode: vi.fn()
}))
vi.mock('../../../shared/secure-file', () => ({
  writeSecureJsonFile: vi.fn((path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(value))
    return true
  })
}))
let root: string | undefined
afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})
const settings = {
  agentCmdOverrides: { dsh: process.execPath, zcode: process.execPath },
  agentDefaultArgs: { dsh: '--profile inherited', zcode: '--mode yolo --verbose' },
  agentDefaultEnv: {}
}
const args = async () => ({
  settings,
  cwd: process.cwd(),
  root: (root = await mkdtemp(join(tmpdir(), 'node-launch-')))
})

describe('isolated workflow node configuration', () => {
  it('applies DSH sandbox and approval independently and rejects unsupported network policies', async () => {
    vi.mocked(inspectDsh).mockResolvedValue({
      profiles: [],
      plugins: [
        { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-policy', disabled: true, config: {} },
        { id: 'approval', name: '@deepseek-ai/dsh-user-approval', disabled: true, config: {} }
      ]
    })
    const input = await args()
    const prepared = await prepareWorkflowNodeSettings({
      ...input,
      agent: 'dsh',
      launch: { security: { access: 'read-only', approval: 'never' } }
    })
    expect(JSON.parse(await readFile(prepared.patch ?? '', 'utf8'))).toEqual([
      { id: 'sandbox', disabled: false, config: { mode: 'read-only', workspaceRoot: input.cwd } },
      { id: 'approval', disabled: false, config: { policy: 'never' } }
    ])
    expect(prepared.environment.DSH_PERMISSION_MODE).toBe('read-only')
    await prepared.cleanup()
    await expect(
      prepareWorkflowNodeSettings({
        ...input,
        agent: 'dsh',
        launch: { security: { access: 'workspace-write', network: 'deny' } }
      })
    ).rejects.toThrow('does not support')
  })
  it('applies DSH model, effort, permissions and extensions, then cleans up without modifying defaults', async () => {
    vi.mocked(inspectDsh).mockResolvedValue({
      profiles: [],
      plugins: [
        { id: 'model', name: '@deepseek-ai/dsh-agent-default-model', disabled: false, config: {} },
        { id: 'provider', name: 'provider-plugin', disabled: true, config: {} },
        { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-policy', disabled: false, config: {} },
        { id: 'approval', name: '@deepseek-ai/dsh-user-approval', disabled: false, config: {} }
      ]
    })
    const input = await args()
    const launch = {
      profile: 'node-profile',
      model: 'deepseek-test',
      provider: 'paid-plan',
      effort: 'high',
      permission: 'danger-full-access',
      plugins: ['provider']
    }
    const prepared = await prepareWorkflowNodeSettings({ ...input, agent: 'dsh', launch })
    expect(prepared.patch).toBeDefined()
    expect(JSON.parse(await readFile(prepared.patch ?? '', 'utf8'))).toEqual([
      { id: 'sandbox', config: { mode: 'danger-full-access', workspaceRoot: input.cwd } },
      { id: 'approval', config: { policy: 'never' } },
      {
        id: 'model',
        config: { model: 'deepseek-test', provider: 'paid-plan', reasoningEffort: 'high' }
      },
      { id: 'provider', disabled: false }
    ])
    const command = buildWorkflowHeadlessCommand({
      ...input,
      agent: 'dsh',
      spec: 'task',
      launch,
      ...prepared,
      signal: new AbortController().signal
    })
    expect(command.args?.slice(0, 4)).toEqual([
      '--profile',
      'node-profile',
      '--patch',
      prepared.patch
    ])
    expect(command.env?.DSH_PERMISSION_MODE).toBe('danger-full-access')
    expect(settings.agentDefaultArgs.dsh).toBe('--profile inherited')
    await prepared.cleanup()
    expect(await readdir(input.root)).toEqual([])
    const next = await prepareWorkflowNodeSettings({ ...input, agent: 'dsh' })
    expect(next.environment).toEqual({})
    expect(next.patch).toBeUndefined()
  })

  it('isolates ZCode provider and extensions while retaining account rules and original storage', async () => {
    const original = {
      schemaVersion: 1,
      config: {
        accountRules: { key: 'fixture-secret' },
        defaultModelSelection: { providerId: 'plan', modelId: 'old', options: { temperature: 0 } }
      }
    }
    const input = await args()
    vi.mocked(inspectZcode).mockResolvedValue({
      providerPath: join(input.root, 'original.json'),
      provider: original,
      user: { storage: { dir: input.root }, plugins: { enabledPlugins: { existing: true } } },
      project: {},
      plugins: [{ id: 'new-plugin', name: 'New plugin', enabled: false, rootPath: input.root }],
      servers: { server: { type: 'stdio', command: 'node', enabled: false } }
    })
    const launch = {
      model: 'new',
      effort: 'high',
      permission: 'guarded',
      plugins: ['new-plugin'],
      mcpServers: ['server']
    }
    const prepared = await prepareWorkflowNodeSettings({ ...input, agent: 'zcode', launch })
    const provider = JSON.parse(
      await readFile(prepared.environment.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ?? '', 'utf8')
    )
    expect(provider.config.defaultModelSelection).toEqual({
      providerId: 'plan',
      modelId: 'new',
      options: { temperature: 0, reasoningLevel: 'high' }
    })
    expect(provider.config.accountRules).toEqual(original.config.accountRules)
    expect(original.config.defaultModelSelection.modelId).toBe('old')
    const config = JSON.parse(
      await readFile(join(prepared.environment.HOME ?? '', '.zcode', 'cli', 'config.json'), 'utf8')
    )
    expect(config.plugins.enabledPlugins).toEqual({ existing: true, 'new-plugin': true })
    expect(config.storage.dir).toBe(input.root)
    expect(config.mcp.servers.server.enabled).toBe(true)
    const command = buildWorkflowHeadlessCommand({
      ...input,
      agent: 'zcode',
      spec: 'task',
      launch,
      ...prepared,
      signal: new AbortController().signal
    })
    expect(command.args).toEqual(expect.arrayContaining(['--mode', 'guarded', '--verbose']))
    expect(command.args).not.toContain('yolo')
    await prepared.cleanup()
    expect(await readdir(input.root)).toEqual([])
  })

  it('fails before launch when a selected extension disappeared or private writes cannot be secured', async () => {
    const input = await args()
    vi.mocked(inspectDsh).mockResolvedValue({ profiles: [], plugins: [] })
    await expect(
      prepareWorkflowNodeSettings({ ...input, agent: 'dsh', launch: { plugins: ['gone'] } })
    ).rejects.toThrow('no longer installed')
    vi.mocked(inspectDsh).mockResolvedValue({
      profiles: [],
      plugins: [{ id: 'plugin', name: 'external', disabled: true, config: {} }]
    })
    vi.mocked(writeSecureJsonFile).mockReturnValueOnce(false)
    await expect(
      prepareWorkflowNodeSettings({ ...input, agent: 'dsh', launch: { plugins: ['plugin'] } })
    ).rejects.toThrow('Cannot secure')
    expect(await readdir(input.root)).toEqual([])
  })
})
