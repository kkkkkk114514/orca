// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorktreeWorkflowButton } from './WorktreeWorkflowButton'
import { openWorkspaceWorkflow } from '../workflow-canvas/workflow-workspace-navigation'
vi.mock('../workflow-canvas/workflow-workspace-navigation', () => ({
  openWorkspaceWorkflow: vi.fn(() => true)
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('opens the workspace workflow without bubbling into row selection or rename', () => {
  const row = vi.fn()
  const opened = vi.fn()
  render(
    <TooltipProvider>
      <div onClick={row} onDoubleClick={row} onPointerDown={row}>
        <WorktreeWorkflowButton
          worktreeId="workspace-a"
          label="Workspace A"
          executionHostId="runtime:remote"
          onOpened={opened}
        />
      </div>
    </TooltipProvider>
  )
  const button = screen.getByRole('button', { name: 'Open workflow for Workspace A' })
  fireEvent.pointerDown(button)
  fireEvent.click(button)
  fireEvent.doubleClick(button)
  expect(openWorkspaceWorkflow).toHaveBeenCalledWith('workspace-a', 'runtime:remote')
  expect(opened).toHaveBeenCalledTimes(1)
  expect(row).not.toHaveBeenCalled()
})
