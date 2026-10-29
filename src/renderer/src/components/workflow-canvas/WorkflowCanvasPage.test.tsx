// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkflowExecution } from '../../../../shared/workflow-executor'
import { workflowDefinitionSchema } from '../../../../shared/workflow-definition'
import { createUuidV4 } from '../../../../shared/uuid-v4'
import { workflowToCanvas } from './workflow-canvas-document'
import { useWorkflowRun } from './use-workflow-run'
import type { WorkflowCanvasGraph } from './WorkflowCanvasGraph'
import type * as WorkflowRunPanelModule from './WorkflowRunPanel'
import WorkflowCanvasPage from './WorkflowCanvasPage'

vi.mock('./use-workflow-run', () => ({ useWorkflowRun: vi.fn() }))
vi.mock('./workflow-session-navigation', () => ({ openWorkflowSession: vi.fn() }))
vi.mock('./WorkflowCanvasNode', async () => {
  const { createContext } = await import('react')
  return { WorkflowCanvasSessionContext: createContext(null) }
})
vi.mock('./WorkflowStepActivity', () => ({ WorkflowSelectedNodeActivity: () => null }))
vi.mock('./WorkflowCanvasToolbar', () => ({ WorkflowCanvasToolbar: () => null }))
vi.mock('./WorkflowRunPanel', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkflowRunPanelModule>()),
  WorkflowRunPanel: () => null
}))
vi.mock('./WorkflowCanvasInspector', () => ({
  WorkflowCanvasInspector: ({ node }: { node?: { id: string } }) => (
    <div data-testid="selected-node">{node?.id}</div>
  )
}))
vi.mock('./WorkflowCanvasGraph', () => ({
  WorkflowCanvasGraph: ({ document, setDocument }: ComponentProps<typeof WorkflowCanvasGraph>) => (
    <>
      <output data-testid="graph-state">{JSON.stringify(document)}</output>
      <button
        onClick={() =>
          setDocument((current) => ({
            ...current,
            viewport: { x: 50, y: 60, zoom: 0.7 },
            nodes: current.nodes.map((node) => ({
              ...node,
              selected: node.id === 'develop',
              measured: { width: 280, height: 200 }
            }))
          }))
        }
      >
        Select and measure
      </button>
    </>
  )
}))

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.clearAllMocks()
})

it('keeps execution graph interactions across polls without overwriting a draft with changed permissions', () => {
  const definition = workflowDefinitionSchema.parse({
    version: 2,
    name: 'Original run',
    entry: 'develop',
    maxSteps: 2,
    nodes: [
      {
        id: 'develop',
        type: 'agent',
        agent: 'codex',
        prompt: 'Work',
        onSuccess: 'done',
        onFailure: 'done'
      },
      { id: 'done', type: 'end', outcome: 'succeeded' }
    ]
  })
  const draft = workflowToCanvas(definition)
  draft.name = 'Edited draft'
  draft.nodes[0].data.launch = { security: { access: 'workspace-write', approval: 'never' } }
  localStorage.setItem('orca.workflow-canvas.v1', JSON.stringify(draft))
  const execution = createWorkflowExecution(
    definition,
    'Task',
    {
      worktree: 'folder:test',
      target: 'local'
    },
    'test-runtime'
  )
  const run = {
    binding: { id: createUuidV4(), target: { kind: 'local' as const }, workspaceLabel: 'Test' },
    previous: null,
    snapshot: {
      id: createUuidV4(),
      createdAt: 1,
      worktree: 'folder:test',
      phase: 'running' as const,
      execution
    },
    busy: false,
    error: '',
    start: vi.fn(),
    clear: vi.fn(),
    detach: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
  vi.mocked(useWorkflowRun).mockReturnValue(run)
  const view = render(<WorkflowCanvasPage />)
  expect(view.container.querySelector('fieldset')).toBeDisabled()
  fireEvent.click(screen.getByText('Select and measure'))
  expect(screen.getByTestId('selected-node')).toHaveTextContent('develop')
  expect(JSON.parse(screen.getByTestId('graph-state').textContent ?? '{}')).toMatchObject({
    name: 'Original run',
    viewport: { x: 50, y: 60, zoom: 0.7 },
    nodes: [
      { id: 'develop', selected: true, measured: { width: 280, height: 200 } },
      { id: 'done' }
    ]
  })
  const selectedGraph = screen.getByTestId('graph-state').textContent
  vi.mocked(useWorkflowRun).mockReturnValue({ ...run, snapshot: structuredClone(run.snapshot) })
  view.rerender(<WorkflowCanvasPage />)
  expect(screen.getByTestId('selected-node')).toHaveTextContent('develop')
  expect(screen.getByTestId('graph-state').textContent).toBe(selectedGraph)
  const finishedRun = {
    ...run,
    snapshot: { ...run.snapshot, phase: 'failed' as const, error: 'Host stopped scheduling' }
  }
  vi.mocked(useWorkflowRun).mockReturnValue(finishedRun)
  view.rerender(<WorkflowCanvasPage />)
  expect(view.container.querySelector('fieldset')).not.toBeDisabled()
  expect(JSON.parse(screen.getByTestId('graph-state').textContent ?? '{}').name).toBe(
    'Edited draft'
  )
  fireEvent.click(screen.getByRole('button', { name: 'View this run’s canvas' }))
  expect(view.container.querySelector('fieldset')).toBeDisabled()
  expect(screen.getByTestId('graph-state').textContent).toBe(selectedGraph)
  vi.mocked(useWorkflowRun).mockReturnValue({
    ...finishedRun,
    snapshot: structuredClone(finishedRun.snapshot)
  })
  view.rerender(<WorkflowCanvasPage />)
  expect(screen.getByTestId('graph-state').textContent).toBe(selectedGraph)
  fireEvent.click(screen.getByRole('button', { name: 'Edit next draft' }))
  expect(view.container.querySelector('fieldset')).not.toBeDisabled()
  expect(JSON.parse(screen.getByTestId('graph-state').textContent ?? '{}').name).toBe(
    'Edited draft'
  )
  vi.mocked(useWorkflowRun).mockReturnValue({ ...run, binding: null, snapshot: null })
  view.rerender(<WorkflowCanvasPage />)
  expect(JSON.parse(screen.getByTestId('graph-state').textContent ?? '{}')).toMatchObject({
    name: 'Edited draft',
    nodes: [
      { data: { launch: { security: { access: 'workspace-write', approval: 'never' } } } },
      { id: 'done' }
    ]
  })
  act(() => view.unmount())
  expect(JSON.parse(localStorage.getItem('orca.workflow-canvas.v1') ?? '{}')).toMatchObject({
    name: 'Edited draft',
    nodes: [{ data: { launch: { security: { access: 'workspace-write' } } } }, { id: 'done' }]
  })
})
