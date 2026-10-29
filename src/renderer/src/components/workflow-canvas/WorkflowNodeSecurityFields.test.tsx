// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkflowNodeSecurityFields } from './WorkflowNodeSecurityFields'
import { workflowSecurityCapabilities } from '../../../../shared/workflow-node-security'

afterEach(cleanup)

it('edits separate permissions and host paths while preserving unrelated node overrides', () => {
  const onChange = vi.fn()
  const value = { model: 'kept', security: { access: 'workspace-write' as const } }
  const view = render(
    <WorkflowNodeSecurityFields
      agent="codex"
      value={value}
      capabilities={workflowSecurityCapabilities('codex')}
      onChange={onChange}
    />
  )
  fireEvent.click(screen.getByRole('combobox', { name: 'Approval policy' }))
  fireEvent.click(screen.getByRole('option', { name: /Never ask/ }))
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    model: 'kept',
    security: { access: 'workspace-write', approval: 'never' }
  })
  const dirs = screen.getByRole('textbox', { name: 'Additional writable directories' })
  fireEvent.change(dirs, { target: { value: 'D:\\cache\nD:\\cache\nD:\\screenshots\n' } })
  fireEvent.blur(dirs)
  expect(onChange.mock.lastCall?.[0].security.writableDirectories).toEqual([
    'D:\\cache',
    'D:\\screenshots'
  ])
  view.rerender(
    <WorkflowNodeSecurityFields
      agent="codex"
      value={{ ...value, security: { access: 'workspace-write', network: 'restricted' } }}
      capabilities={workflowSecurityCapabilities('codex')}
      onChange={onChange}
    />
  )
  const hosts = screen.getByRole('textbox', { name: 'Allowed hostnames' })
  fireEvent.change(hosts, { target: { value: 'registry.npmjs.org\n*.example.com' } })
  fireEvent.blur(hosts)
  expect(onChange.mock.lastCall?.[0].security.allowedHosts).toEqual([
    'registry.npmjs.org',
    '*.example.com'
  ])
})

it('keeps unconfirmed capabilities disabled and migrates an old DSH mode only when edited', () => {
  const onChange = vi.fn()
  const view = render(<WorkflowNodeSecurityFields agent="codex" value={{}} onChange={onChange} />)
  expect(screen.getByRole('combobox', { name: 'Filesystem access' })).toBeDisabled()
  expect(screen.getByRole('combobox', { name: 'Command network access' })).toBeDisabled()
  view.rerender(
    <WorkflowNodeSecurityFields
      agent="dsh"
      value={{ permission: 'workspace-write' }}
      capabilities={workflowSecurityCapabilities('dsh')}
      onChange={onChange}
    />
  )
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('combobox', { name: 'Approval policy' }))
  fireEvent.click(screen.getByRole('option', { name: /Never ask/ }))
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    permission: undefined,
    security: { access: 'workspace-write', approval: 'never' }
  })
})
