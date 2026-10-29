// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { readHostAgentLaunchSettings } from '../settings/agent-launch-settings-transport'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import { getDefaultSettings } from '../../../../shared/constants'
import { WorkflowAgentPicker } from './WorkflowAgentPicker'

vi.mock('@/hooks/useDetectedAgents', () => ({ useDetectedAgents: vi.fn() }))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => ({ kind: 'local' })
}))
vi.mock('../settings/agent-launch-settings-transport', () => ({
  readHostAgentLaunchSettings: vi.fn()
}))
const initial = useAppStore.getInitialState()
const local = {
  target: { kind: 'local' as const },
  worktreeId: 'folder:test',
  label: 'Test workspace'
}
const remote = { ...local, target: { kind: 'environment' as const, environmentId: 'remote-a' } }
const refresh = vi.fn(async () => ['codex', 'dsh', 'zcode'] as const)
beforeEach(() => {
  useAppStore.setState({
    ...initial,
    settings: {
      ...getDefaultSettings('/tmp'),
      ...initial.settings,
      disabledTuiAgents: ['zcode'],
      agentCmdOverrides: { codex: 'D:/CLI/codexCLI/codex.cmd' }
    }
  })
  vi.mocked(useDetectedAgents).mockReturnValue({
    detectedIds: ['codex', 'dsh', 'zcode'],
    isLoading: false,
    isRefreshing: false,
    detectionFailed: false,
    needsServerUpdate: false,
    refresh: async () => [...(await refresh())]
  })
  vi.mocked(readHostAgentLaunchSettings).mockResolvedValue(
    projectAgentLaunchSettings({
      disabledTuiAgents: ['codex', 'zcode'],
      agentCmdOverrides: { dsh: '/remote/bin/dsh' }
    })
  )
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial)
  vi.clearAllMocks()
})

it('offers only detected enabled agents, shows the actual command and keeps an unavailable saved selection', () => {
  const changed = vi.fn()
  render(<WorkflowAgentPicker value="claude" target={local} onChange={changed} />)
  expect(screen.getByRole('combobox', { name: 'Agent' })).toHaveTextContent('Claude')
  expect(screen.getByRole('status')).toHaveTextContent('Not detected on this host')
  expect(changed).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }))
  expect(screen.getByRole('option', { name: /Codex/ })).toHaveTextContent(
    'D:/CLI/codexCLI/codex.cmd'
  )
  expect(screen.getByRole('option', { name: /Claude/ })).toHaveAttribute('aria-disabled', 'true')
  expect(screen.queryByRole('option', { name: /ZCode/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('option', { name: /Gemini/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('option', { name: /DeepSeek Harness/ }))
  expect(changed).toHaveBeenCalledWith('dsh')
  expect(useDetectedAgents).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'local', worktreeId: local.worktreeId })
  )
})

it('updates from the same local enable settings and can refresh the shared detection inventory', async () => {
  render(<WorkflowAgentPicker value="codex" target={local} onChange={vi.fn()} />)
  fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }))
  act(() =>
    useAppStore.setState((state) => ({
      settings: { ...getDefaultSettings('/tmp'), ...state.settings, disabledTuiAgents: ['dsh'] }
    }))
  )
  expect(screen.queryByRole('option', { name: /DeepSeek Harness/ })).not.toBeInTheDocument()
  expect(screen.getByRole('option', { name: /ZCode/ })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh agents' }))
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
})

it('waits for local settings before offering cached agents and requires a workspace target', () => {
  useAppStore.setState({ settings: null })
  const changed = vi.fn()
  const view = render(<WorkflowAgentPicker value="codex" target={local} onChange={changed} />)
  const trigger = screen.getByRole('combobox', { name: 'Agent' })
  fireEvent.click(trigger)
  expect(screen.queryByRole('option')).not.toBeInTheDocument()
  act(() =>
    useAppStore.setState({
      settings: { ...getDefaultSettings('/tmp'), disabledTuiAgents: ['dsh'] }
    })
  )
  expect(screen.getByRole('option', { name: /Codex/ })).toBeInTheDocument()
  expect(screen.queryByRole('option', { name: /DeepSeek Harness/ })).not.toBeInTheDocument()
  view.rerender(<WorkflowAgentPicker value="codex" target={null} onChange={changed} />)
  expect(trigger).toBeDisabled()
  expect(useDetectedAgents).toHaveBeenLastCalledWith(undefined)
  expect(changed).not.toHaveBeenCalled()
})

it('uses the selected remote host settings and never falls back to local enabled agents while loading', async () => {
  let finish: ((value: ReturnType<typeof projectAgentLaunchSettings>) => void) | undefined
  vi.mocked(readHostAgentLaunchSettings).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const changed = vi.fn()
  render(<WorkflowAgentPicker value="codex" target={remote} onChange={changed} />)
  fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }))
  expect(screen.queryByRole('option')).not.toBeInTheDocument()
  await act(async () =>
    finish?.(
      projectAgentLaunchSettings({
        disabledTuiAgents: ['codex', 'zcode'],
        agentCmdOverrides: { dsh: '/remote/bin/dsh' }
      })
    )
  )
  expect(screen.getByRole('option', { name: /DeepSeek Harness/ })).toHaveTextContent(
    '/remote/bin/dsh'
  )
  expect(screen.getByRole('option', { name: /Codex/ })).toHaveAttribute('aria-disabled', 'true')
  expect(screen.queryByRole('option', { name: /ZCode/ })).not.toBeInTheDocument()
  expect(changed).not.toHaveBeenCalled()
  expect(useDetectedAgents).toHaveBeenCalledWith({
    kind: 'runtime',
    environmentId: 'remote-a',
    worktreeId: local.worktreeId
  })
})

it('allows a failed local detection to be refreshed without offering the static catalog', async () => {
  const current = vi.mocked(useDetectedAgents).getMockImplementation()?.(undefined)
  if (!current) {
    throw new Error('Detection fixture unavailable')
  }
  vi.mocked(useDetectedAgents).mockReturnValue({ ...current, detectedIds: null, isLoading: true })
  const view = render(<WorkflowAgentPicker value="codex" target={local} onChange={vi.fn()} />)
  vi.mocked(useDetectedAgents).mockReturnValue({ ...current, detectedIds: null, isLoading: false })
  view.rerender(<WorkflowAgentPicker value="codex" target={local} onChange={vi.fn()} />)
  expect(screen.getByRole('alert')).toHaveTextContent('Agent detection failed')
  fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }))
  expect(screen.queryByRole('option')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh agents' }))
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
})

it('ignores settings from a previous remote host and exposes unsupported hosts without a catalog fallback', async () => {
  let finish: ((value: ReturnType<typeof projectAgentLaunchSettings>) => void) | undefined
  vi.mocked(readHostAgentLaunchSettings)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    .mockResolvedValueOnce(null)
  const changed = vi.fn()
  const view = render(<WorkflowAgentPicker value="codex" target={remote} onChange={changed} />)
  view.rerender(
    <WorkflowAgentPicker
      value="codex"
      target={{ ...remote, target: { kind: 'environment', environmentId: 'remote-b' } }}
      onChange={changed}
    />
  )
  await screen.findByRole('alert')
  await act(async () => finish?.(projectAgentLaunchSettings({})))
  fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }))
  expect(screen.queryByRole('option')).not.toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('Update the execution host')
  expect(changed).not.toHaveBeenCalled()
})
