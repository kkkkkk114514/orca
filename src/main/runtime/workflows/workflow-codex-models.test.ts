import { afterEach, expect, it, vi } from 'vitest'
import { runCodexAppServerSession } from '../../codex/codex-app-server-session'
import { fetchCodexModelCatalogListing } from '../../codex/codex-structured-model-catalog'
import { readCodexConfiguredLaunchDefaults } from '../../codex/codex-configured-launch-defaults'
import { readWorkflowCodexModels } from './workflow-codex-models'

vi.mock('../../codex/codex-app-server-session', () => ({ runCodexAppServerSession: vi.fn() }))
vi.mock('../../codex/codex-structured-model-catalog', () => ({
  fetchCodexModelCatalogListing: vi.fn()
}))
vi.mock('../../codex/codex-configured-launch-defaults', () => ({
  readCodexConfiguredLaunchDefaults: vi.fn()
}))
vi.mock('../../native-chat/structured-agent-command-resolution', () => ({
  resolveStructuredAgentCommand: () => '/configured/codex'
}))
afterEach(() => vi.resetAllMocks())

const settings = {
  agentCmdOverrides: {},
  agentDefaultArgs: { codex: '--profile personal -c model_provider="gateway"' },
  agentDefaultEnv: { codex: { CODEX_HOME: '/configured/home' } }
}
const rpc = { request: vi.fn(), notify: vi.fn() }

it('uses the configured CLI environment and read-only discovery, including a configured unlisted model', async () => {
  vi.mocked(runCodexAppServerSession).mockImplementation(async (_invocation, body) => body(rpc))
  vi.mocked(fetchCodexModelCatalogListing).mockResolvedValue({
    models: [{ id: 'new-model', label: 'New model', isDefault: true, efforts: [] }],
    complete: true,
    configured: { model: 'private-model' }
  })
  const signal = new AbortController().signal
  expect(await readWorkflowCodexModels(settings, '/workspace', signal)).toEqual({
    models: [
      { id: 'private-model', label: 'private-model' },
      { id: 'new-model', label: 'New model' }
    ],
    warnings: []
  })
  const invocation = vi.mocked(runCodexAppServerSession).mock.calls[0]?.[0]
  expect({
    command: invocation?.command,
    cwd: invocation?.cwd,
    signal: invocation?.signal,
    home: invocation?.env?.CODEX_HOME,
    background: invocation?.env?.ORCA_BACKGROUND_LAUNCH,
    args: invocation?.args
  }).toEqual({
    command: '/configured/codex',
    cwd: '/workspace',
    signal,
    home: '/configured/home',
    background: '1',
    args: expect.arrayContaining([
      '--profile',
      'personal',
      'model_provider=gateway',
      'read-only',
      'never',
      'app-server',
      'features.plugins=false'
    ])
  })
  expect(fetchCodexModelCatalogListing).toHaveBeenCalledWith({ connection: rpc, cwd: '/workspace' })
})

it('keeps the configured model when discovery is unsupported and never substitutes static candidates', async () => {
  vi.mocked(runCodexAppServerSession).mockImplementation(async (_invocation, body) => body(rpc))
  vi.mocked(fetchCodexModelCatalogListing).mockRejectedValue(new Error('old CLI'))
  vi.mocked(readCodexConfiguredLaunchDefaults).mockResolvedValue({
    model: 'configured',
    effort: null
  })
  const result = await readWorkflowCodexModels(settings, '/workspace')
  expect(result.models).toEqual([{ id: 'configured', label: 'configured' }])
  expect(result.warnings).toHaveLength(1)
  vi.mocked(readCodexConfiguredLaunchDefaults).mockResolvedValue(null)
  expect((await readWorkflowCodexModels(settings, '/workspace')).models).toEqual([])
})
