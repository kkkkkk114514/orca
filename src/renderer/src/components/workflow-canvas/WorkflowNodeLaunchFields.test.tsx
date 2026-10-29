// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowNodeLaunchFields } from './WorkflowNodeLaunchFields'
import { WorkflowCanvasInspector } from './WorkflowCanvasInspector'
import { createWorkflowCanvasTemplate } from './workflow-canvas-document'

const rpc = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc.call }))
vi.mock('./use-workflow-agent-inventory', async () => {
  const { getAgentCatalog } = await import('@/lib/agent-catalog')
  return {
    useWorkflowAgentInventory: () => ({
      available: getAgentCatalog().filter((agent) => ['codex', 'dsh'].includes(agent.id)),
      settings: { disabledTuiAgents: [], agentCmdOverrides: {} },
      ready: true,
      busy: false,
      error: '',
      refresh: vi.fn()
    })
  }
})
const options = {
  profiles: [],
  models: [{ id: 'host-model', label: 'Host model' }],
  plugins: [{ id: 'plugin', label: 'Host plugin', enabled: false }],
  mcpServers: [],
  skills: [{ id: 'skill', label: 'Host skill', description: null }],
  warnings: []
}
const target = {
  target: { kind: 'environment', environmentId: 'host-a' },
  worktreeId: 'folder:fixture',
  label: 'Folder'
} as const
beforeEach(() => {
  rpc.call.mockReset()
  rpc.call.mockResolvedValue(options)
})
afterEach(() => {
  cleanup()
})

describe('workflow node launch controls', () => {
  it('selects same-name models with their provider and refreshes the CLI inventory', async () => {
    rpc.call.mockResolvedValue({
      ...options,
      models: [
        { id: 'same', label: 'Same model', provider: 'provider-a' },
        { id: 'same', label: 'Same model', provider: 'provider-b' }
      ]
    })
    const onChange = vi.fn()
    render(<WorkflowNodeLaunchFields agent="zcode" target={target} onChange={onChange} />)
    const picker = await screen.findByRole('combobox', { name: 'CLI models' })
    fireEvent.click(picker)
    fireEvent.click(await screen.findByRole('option', { name: 'Same model · provider-b' }))
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ model: 'same', provider: 'provider-b' })
    rpc.call.mockResolvedValue({ ...options, models: [{ id: 'updated', label: 'Updated' }] })
    fireEvent.click(screen.getByRole('button', { name: /^Refresh$/ }))
    await waitFor(() => expect(rpc.call).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getAllByText('Updated').length).toBeGreaterThan(0))
  })

  it('stores model and extension overrides while leaving an adjacent node inherited', async () => {
    const document = createWorkflowCanvasTemplate()
    const onChange = vi.fn()
    render(
      <WorkflowCanvasInspector
        document={document}
        node={document.nodes[0]}
        executionTarget={target}
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'node-model' } })
    expect(onChange.mock.lastCall?.[0]).toMatchObject({
      version: 2,
      nodes: [{ data: { launch: { model: 'node-model' } } }, {}, {}, {}]
    })
    expect(onChange.mock.lastCall?.[0].nodes[1].data.launch).toBeUndefined()
    await waitFor(() => expect(screen.getByText('Host plugin')).toBeDefined())
    fireEvent.click(screen.getByRole('checkbox', { name: 'Plugins: Host plugin' }))
    expect(onChange.mock.lastCall?.[0].nodes[0].data.launch).toEqual({ plugins: ['plugin'] })
    expect(rpc.call.mock.calls[0][0]).toEqual(target.target)
    expect(rpc.call.mock.calls[0][2]).toMatchObject({ worktree: 'id:folder:fixture' })
  })

  it('ignores a stale host inventory and clears loading when the workspace is removed', async () => {
    let oldReply: ((value: unknown) => void) | undefined
    rpc.call.mockReturnValueOnce(
      new Promise((resolve) => {
        oldReply = resolve
      })
    )
    const onChange = vi.fn()
    const view = render(
      <WorkflowNodeLaunchFields agent="dsh" target={target} onChange={onChange} />
    )
    await waitFor(() => expect(rpc.call).toHaveBeenCalledTimes(1))
    view.rerender(
      <WorkflowNodeLaunchFields
        agent="dsh"
        target={{ ...target, target: { kind: 'environment', environmentId: 'host-b' } }}
        onChange={onChange}
      />
    )
    await waitFor(() => expect(screen.getByText('Host plugin')).toBeDefined())
    await act(async () => {
      oldReply?.({ ...options, plugins: [{ id: 'stale', label: 'Stale plugin', enabled: false }] })
    })
    expect(screen.queryByText('Stale plugin')).toBeNull()
    expect(screen.getByText('Host plugin')).toBeDefined()
    view.rerender(<WorkflowNodeLaunchFields agent="dsh" target={null} onChange={onChange} />)
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByText(/Select an execution workspace/)).toBeDefined()
  })

  it('clears native overrides when switching the CLI', () => {
    const document = createWorkflowCanvasTemplate()
    document.version = 2
    document.nodes[0].data.launch = {
      model: 'old',
      permission: 'danger-full-access',
      plugins: ['old-plugin']
    }
    const onChange = vi.fn()
    render(
      <WorkflowCanvasInspector
        document={document}
        node={document.nodes[0]}
        executionTarget={target}
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }))
    fireEvent.click(screen.getByRole('option', { name: /Codex/ }))
    expect(onChange.mock.lastCall?.[0].nodes[0].data).toMatchObject({
      agent: 'codex',
      launch: undefined
    })
  })
})
