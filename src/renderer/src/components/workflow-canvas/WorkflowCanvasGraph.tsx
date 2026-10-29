import { useRef, type Dispatch, type SetStateAction } from 'react'
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow
} from '@xyflow/react'
import { translate } from '@/i18n/i18n'
import type { WorkflowRunSnapshot } from '../../../../shared/workflow-run-contract'
import {
  connectWorkflowCanvas,
  type WorkflowCanvasDocument,
  type WorkflowCanvasEdge,
  type WorkflowCanvasNode as CanvasNode
} from './workflow-canvas-document'
import {
  WorkflowCanvasEntryContext,
  WorkflowCanvasNode,
  WorkflowCanvasRunContext
} from './WorkflowCanvasNode'
const nodeTypes = { workflow: WorkflowCanvasNode }

export function WorkflowCanvasGraph({
  document,
  edges,
  setDocument,
  commit,
  locked,
  snapshot,
  setInspectorOpen
}: {
  document: WorkflowCanvasDocument
  edges: WorkflowCanvasEdge[]
  setDocument: Dispatch<SetStateAction<WorkflowCanvasDocument>>
  commit: (next: WorkflowCanvasDocument, previous?: WorkflowCanvasDocument) => void
  locked: boolean
  snapshot: WorkflowRunSnapshot | null
  setInspectorOpen: (open: boolean) => void
}) {
  const flow = useReactFlow<CanvasNode, WorkflowCanvasEdge>()
  const dragStart = useRef<WorkflowCanvasDocument | undefined>(undefined)
  return (
    <div className="relative min-w-0 flex-1" data-testid="workflow-graph">
      <WorkflowCanvasRunContext.Provider value={snapshot}>
        <WorkflowCanvasEntryContext.Provider value={document.entry}>
          <ReactFlow<CanvasNode, WorkflowCanvasEdge>
            nodes={document.nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            nodesDraggable={!locked}
            nodesConnectable={!locked}
            onNodesChange={(changes) => {
              if (
                !dragStart.current &&
                changes.some((change) => change.type === 'position' && change.dragging === false)
              ) {
                commit({ ...document, nodes: applyNodeChanges(changes, document.nodes) })
                return
              }
              setDocument((current) => ({
                ...current,
                nodes: applyNodeChanges(changes, current.nodes)
              }))
            }}
            onEdgesChange={(changes) =>
              setDocument((current) => ({
                ...current,
                edges: applyEdgeChanges(changes, current.edges)
              }))
            }
            onConnect={(connection) => commit(connectWorkflowCanvas(document, connection))}
            onNodeDragStart={() => {
              dragStart.current = document
            }}
            onNodeDragStop={() => {
              if (dragStart.current) {
                commit({ ...document, nodes: flow.getNodes() }, dragStart.current)
                dragStart.current = undefined
              }
            }}
            onMoveEnd={(_event, viewport) => setDocument((current) => ({ ...current, viewport }))}
            onNodeDoubleClick={() => setInspectorOpen(true)}
            defaultViewport={document.viewport}
            fitView={!document.viewport}
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            minZoom={0.15}
            maxZoom={2}
            deleteKeyCode={null}
            edgesReconnectable={false}
            aria-label={translate('workflows.graph', 'Workflow graph')}
            ariaLabelConfig={{
              'node.a11yDescription.default': translate(
                'workflows.nodeKeyboardHint',
                'Use arrow keys to move the selected node. Use the toolbar to delete it.'
              ),
              'edge.a11yDescription.default': translate(
                'workflows.edgeKeyboardHint',
                'Select a connection and use the toolbar to delete it.'
              ),
              'controls.ariaLabel': translate('workflows.viewControls', 'View controls'),
              'controls.zoomIn.ariaLabel': translate('workflows.zoomIn', 'Zoom in'),
              'controls.zoomOut.ariaLabel': translate('workflows.zoomOut', 'Zoom out'),
              'controls.fitView.ariaLabel': translate('workflows.fitView', 'Fit to view'),
              'minimap.ariaLabel': translate('workflows.minimap', 'Minimap')
            }}
          >
            <Background gap={20} size={1} />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeColor="var(--muted-foreground)"
              nodeStrokeColor="var(--border)"
              maskColor="var(--background)"
              className="hidden sm:block"
            />
          </ReactFlow>
        </WorkflowCanvasEntryContext.Provider>
      </WorkflowCanvasRunContext.Provider>
    </div>
  )
}
