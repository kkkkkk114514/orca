// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkflowNodeConversationFields } from './WorkflowNodeConversationFields'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { WorkflowNodeConversation } from '../../../../shared/workflow-node-conversation'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))
vi.mock('./WorkflowSessionView', () => ({
  WorkflowSessionView: ({ title, nodeId }: { title: string; nodeId: string }) => (
    <p>
      Workflow preview: {title} · {nodeId}
    </p>
  )
}))
vi.mock('../sidebar/WorkspaceSessionHistoryView', () => ({
  WorkspaceSessionHistoryView: ({ title }: { title: string }) => <p>CLI preview: {title}</p>
}))
const target = { target: { kind: 'local' as const }, worktreeId: 'folder:one', label: 'One' }
const rows = [
  {
    key: 'a'.repeat(64),
    title: 'plan · Newest history',
    updatedAt: 2,
    archived: false,
    history: {
      key: 'c'.repeat(64),
      title: 'plan · Newest history',
      updatedAt: 2,
      archived: false,
      source: 'workflow' as const,
      agent: 'codex',
      workflow: { id: '01800000-0000-4000-8000-000000000001', nodeId: 'plan' }
    }
  },
  {
    key: 'b'.repeat(64),
    title: 'Older history',
    updatedAt: 1,
    archived: false,
    history: {
      key: 'd'.repeat(64),
      title: 'Older history',
      updatedAt: 1,
      archived: false,
      source: 'cli' as const,
      agent: 'codex'
    }
  },
  { key: 'e'.repeat(64), title: 'Archived history', updatedAt: 0, archived: true }
]
beforeEach(() => vi.mocked(callRuntimeRpc).mockResolvedValue({ supported: true, rows, issues: [] }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('previews history without changing the node until confirmation and preserves the choice on cancel', async () => {
  const changed = vi.fn<(value: WorkflowNodeConversation | undefined) => void>()
  const view = render(
    <WorkflowNodeConversationFields agent="codex" target={target} onChange={changed} />
  )
  expect(screen.getByRole('radio', { name: 'Automatically choose latest' })).toBeChecked()
  await screen.findByText('Newest history')
  fireEvent.click(screen.getByRole('radio', { name: 'Choose a past conversation' }))
  let dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByText(/Workflow preview: Newest history/)).toBeVisible()
  fireEvent.click(dialog.getByRole('button', { name: /Older history/ }))
  expect(dialog.getByText('CLI preview: Older history')).toBeVisible()
  expect(changed).not.toHaveBeenCalled()
  fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(changed).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Select conversation' }))
  dialog = within(screen.getByRole('dialog'))
  fireEvent.click(dialog.getByRole('button', { name: /Older history/ }))
  fireEvent.click(dialog.getByRole('button', { name: 'Use this conversation' }))
  expect(changed).toHaveBeenLastCalledWith({ mode: 'existing', key: rows[1].key })
  view.rerender(
    <WorkflowNodeConversationFields
      agent="codex"
      target={target}
      value={{ mode: 'existing', key: rows[1].key }}
      onChange={changed}
    />
  )
  expect(screen.getByRole('radio', { name: 'Choose a past conversation' })).toBeChecked()
  expect(screen.getByText('Older history')).toBeVisible()
  fireEvent.click(screen.getByRole('radio', { name: 'New conversation' }))
  expect(changed).toHaveBeenLastCalledWith({ mode: 'new' })
  view.rerender(
    <WorkflowNodeConversationFields
      agent="codex"
      target={target}
      value={{ mode: 'new' }}
      onChange={changed}
    />
  )
  expect(screen.getByText('This run will create a new conversation.')).toBeVisible()
  fireEvent.click(screen.getByRole('radio', { name: 'Automatically choose latest' }))
  expect(changed).toHaveBeenLastCalledWith(undefined)
})

it('filters recent and archived histories and disables confirmation when a candidate is filtered out', async () => {
  const changed = vi.fn()
  render(<WorkflowNodeConversationFields agent="codex" target={target} onChange={changed} />)
  await screen.findByText('Newest history')
  fireEvent.click(screen.getByRole('button', { name: 'Select conversation' }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.queryByRole('button', { name: /Archived history/ })).not.toBeInTheDocument()
  fireEvent.change(dialog.getByRole('textbox', { name: 'Search conversations' }), {
    target: { value: 'Older' }
  })
  expect(dialog.queryByRole('button', { name: /Newest history/ })).not.toBeInTheDocument()
  expect(dialog.getByRole('button', { name: 'Use this conversation' })).toBeDisabled()
  fireEvent.click(dialog.getByRole('button', { name: /Older history/ }))
  expect(dialog.getByRole('button', { name: 'Use this conversation' })).toBeEnabled()
  fireEvent.change(dialog.getByRole('textbox', { name: 'Search conversations' }), {
    target: { value: '' }
  })
  fireEvent.mouseDown(dialog.getByRole('tab', { name: 'Archived' }), { button: 0, ctrlKey: false })
  expect(dialog.getByRole('button', { name: /Archived history/ })).toBeVisible()
  expect(dialog.getByRole('button', { name: 'Use this conversation' })).toBeDisabled()
  fireEvent.click(dialog.getByRole('button', { name: /Archived history/ }))
  expect(dialog.getByText(/Preview is unavailable/)).toBeVisible()
  fireEvent.click(dialog.getByRole('button', { name: 'Use this conversation' }))
  expect(changed).toHaveBeenCalledWith({ mode: 'existing', key: rows[2].key })
})

it('keeps an unavailable explicit choice and ignores a stale workspace response', async () => {
  let finishOld: ((value: unknown) => void) | undefined
  vi.mocked(callRuntimeRpc).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve
      })
  )
  const changed = vi.fn()
  const view = render(
    <WorkflowNodeConversationFields
      agent="codex"
      target={target}
      value={{ mode: 'existing', key: rows[0].key }}
      onChange={changed}
    />
  )
  vi.mocked(callRuntimeRpc).mockResolvedValue({ supported: true, rows: [], issues: [] })
  view.rerender(
    <WorkflowNodeConversationFields
      agent="zcode"
      target={{ ...target, worktreeId: 'folder:two' }}
      value={{ mode: 'existing', key: rows[0].key }}
      onChange={changed}
    />
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Refresh conversations' })).toBeEnabled()
  )
  finishOld?.({ supported: true, rows, issues: [] })
  await waitFor(() => expect(screen.queryByText('Newest history')).not.toBeInTheDocument())
  expect(screen.getByText('Selected conversation is unavailable')).toBeVisible()
  expect(changed).not.toHaveBeenCalled()
})
