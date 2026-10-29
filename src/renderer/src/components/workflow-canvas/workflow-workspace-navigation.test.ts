// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { openWorkspaceWorkflow } from './workflow-workspace-navigation'
import { setAutomationWorkspaceView } from '../automations/automation-workspace-view'

const state = vi.hoisted(() => ({ activate: vi.fn(), open: vi.fn() }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace: state.activate }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ openAutomationsPage: state.open }) }
}))
afterEach(() => {
  vi.resetAllMocks()
  setAutomationWorkspaceView('schedules')
})

it('opens the chosen owner without starting a default agent and flushes pending edits first', () => {
  const flush = vi.fn()
  window.addEventListener('workflow-canvas-flush', flush)
  state.activate.mockReturnValue({ primaryTabId: null })
  expect(openWorkspaceWorkflow('folder:test', 'runtime:remote')).toBe(true)
  expect(state.activate).toHaveBeenCalledWith('folder:test', {
    executionHostId: 'runtime:remote',
    providesInitialSurface: true,
    restoreAgentSessions: false,
    navigationIntent: 'user-open'
  })
  expect(flush.mock.invocationCallOrder[0]).toBeLessThan(state.activate.mock.invocationCallOrder[0])
  expect(state.open).toHaveBeenCalledTimes(1)
  window.removeEventListener('workflow-canvas-flush', flush)
  state.activate.mockReturnValue(false)
  expect(openWorkspaceWorkflow('missing', 'local')).toBe(false)
  expect(state.open).toHaveBeenCalledTimes(1)
})
