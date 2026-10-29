import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { CheckCircle2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { createUuidV4 } from '../../../../shared/uuid-v4'
import { translate } from '@/i18n/i18n'
import {
  workflowDefinitionSchema,
  withWorkflowConversationDefaults
} from '../../../../shared/workflow-definition'
import {
  canvasWorkflowInput,
  createWorkflowCanvasNode,
  importWorkflowCanvas,
  layoutWorkflowCanvas,
  workflowToCanvas,
  workflowCanvasDocumentSchema,
  type WorkflowCanvasDocument,
  type WorkflowCanvasEdge,
  type WorkflowCanvasNode as CanvasNode
} from './workflow-canvas-document'
import { useWorkflowCanvasDocument } from './use-workflow-canvas-document'
import { WorkflowCanvasGraph } from './WorkflowCanvasGraph'
import { WorkflowCanvasSessionContext } from './WorkflowCanvasNode'
import { openWorkflowSession } from './workflow-session-navigation'
import { WorkflowCanvasInspector } from './WorkflowCanvasInspector'
import { WorkflowCanvasToolbar } from './WorkflowCanvasToolbar'
import { WorkflowCanvasHeader } from './WorkflowCanvasHeader'
import {
  WorkflowCanvasRunMode,
  WorkflowRunPanel,
  type WorkflowExecutionTarget
} from './WorkflowRunPanel'
import { useWorkflowRun } from './use-workflow-run'
import { workflowWorkspaceScope } from './workflow-workspace-scope'
import { rememberWorkflowCanvasUsed } from './workflow-canvas-storage'
import { WorkflowSelectedNodeActivity } from './WorkflowStepActivity'
import '@xyflow/react/dist/base.css'
import './workflow-canvas.css'

function downloadJson(value: unknown, name: string): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  )
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function WorkflowCanvasEditor({
  executionTarget,
  workspaceScope
}: {
  executionTarget: WorkflowExecutionTarget | null
  workspaceScope?: string
}) {
  useTranslation()
  const state = useWorkflowCanvasDocument(workspaceScope)
  const { setDocument, commit } = state
  const [notice, setNotice] = useState('')
  const run = useWorkflowRun(workspaceScope, () => {
    if (workspaceScope) {
      try {
        rememberWorkflowCanvasUsed(workspaceScope, state.document)
      } catch {
        setNotice(translate('workflows.saveFailed', 'Local save failed — export a canvas backup'))
      }
    }
  })
  const finished = run.snapshot?.phase === 'succeeded' || run.snapshot?.phase === 'failed'
  const [completedViewId, setCompletedViewId] = useState<string | null>(null)
  const viewingRun = Boolean(run.binding && (!finished || completedViewId === run.binding.id))
  const locked = viewingRun
  const canvasSnapshot = viewingRun ? run.snapshot : null
  const draftDefinition = useMemo(
    () => workflowDefinitionSchema.safeParse(canvasWorkflowInput(state.document)),
    [state.document]
  )
  const executionDefinition = run.snapshot?.execution?.definition
  const executionCanvas = useMemo(
    () => (executionDefinition ? workflowToCanvas(executionDefinition) : null),
    [executionDefinition]
  )
  const executionViewKey =
    viewingRun &&
    run.binding &&
    executionCanvas &&
    JSON.stringify(
      draftDefinition.success ? withWorkflowConversationDefaults(draftDefinition.data) : null
    ) !==
      JSON.stringify(
        executionDefinition ? withWorkflowConversationDefaults(executionDefinition) : null
      )
      ? `${run.binding.id}:${JSON.stringify(executionDefinition)}`
      : null
  const [executionView, setExecutionView] = useState<{
    key: string
    document: WorkflowCanvasDocument
  } | null>(null)
  const document =
    executionViewKey && executionCanvas
      ? executionView?.key === executionViewKey
        ? executionView.document
        : executionCanvas
      : state.document
  const setCanvasDocument: Dispatch<SetStateAction<WorkflowCanvasDocument>> = useCallback(
    (update) => {
      if (executionViewKey && executionCanvas) {
        setExecutionView((current) => {
          const previous = current?.key === executionViewKey ? current.document : executionCanvas
          return {
            key: executionViewKey,
            document: typeof update === 'function' ? update(previous) : update
          }
        })
      } else {
        setDocument(update)
      }
    },
    [executionViewKey, executionCanvas, setDocument]
  )
  const flow = useReactFlow<CanvasNode, WorkflowCanvasEdge>()
  const fileInput = useRef<HTMLInputElement>(null)
  const binding = run.binding
  const openNodeSession = useCallback(
    (nodeId: string) => {
      if (!binding) {
        return
      }
      void openWorkflowSession({
        id: binding.id,
        nodeId,
        target: binding.target,
        label: document.nodes.find((node) => node.id === nodeId)?.data.label || nodeId
      }).catch((error) => setNotice(error instanceof Error ? error.message : String(error)))
    },
    [binding, document.nodes]
  )
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [issuesOpen, setIssuesOpen] = useState(false)
  const selected = document.nodes.find((node) => node.selected)
  const canDelete =
    document.nodes.some((node) => node.selected) || document.edges.some((edge) => edge.selected)
  const validation = useMemo(
    () => workflowDefinitionSchema.safeParse(canvasWorkflowInput(document)),
    [document]
  )
  const edges = useMemo(
    () =>
      document.edges.map((edge) => ({
        ...edge,
        className:
          edge.sourceHandle === 'failed' ? 'workflow-edge-failure' : 'workflow-edge-success'
      })),
    [document.edges]
  )

  const addNode = (kind: 'agent' | 'succeeded' | 'failed'): void => {
    if (document.nodes.length >= 100) {
      return
    }
    const viewport = flow.getViewport()
    const node = createWorkflowCanvasNode(kind, {
      x: (120 - viewport.x) / viewport.zoom,
      y: (100 - viewport.y) / viewport.zoom
    })
    commit({
      ...document,
      nodes: [
        ...document.nodes.map((candidate) => ({ ...candidate, selected: false })),
        { ...node, selected: true }
      ]
    })
    setInspectorOpen(true)
  }

  const deleteSelection = (): void => {
    const removed = new Set(document.nodes.filter((node) => node.selected).map((node) => node.id))
    commit({
      ...document,
      nodes: document.nodes.filter((node) => !removed.has(node.id)),
      edges: document.edges.filter(
        (edge) => !edge.selected && !removed.has(edge.source) && !removed.has(edge.target)
      )
    })
  }

  const importFile = async (file: File | undefined): Promise<void> => {
    if (!file) {
      return
    }
    try {
      if (file.size > 8_000_000) {
        throw new Error(
          translate('workflows.fileTooLarge', 'Choose a JSON file smaller than 8 MB.')
        )
      }
      const next = importWorkflowCanvas(JSON.parse(await file.text()))
      commit({ ...next, workflowId: createUuidV4() })
      setNotice('')
      requestAnimationFrame(() => {
        if (next.viewport) {
          void flow.setViewport(next.viewport, { duration: 0 })
        } else {
          void flow.fitView({ padding: 0.2, duration: 0 })
        }
      })
    } catch (error) {
      setNotice(
        translate('workflows.importFailed', 'Import failed: {{message}}', {
          message: error instanceof Error ? error.message : String(error)
        })
      )
    }
  }

  const exportFile = (canvas: boolean): void => {
    try {
      const value = canvas
        ? workflowCanvasDocumentSchema.parse({ ...document, viewport: flow.getViewport() })
        : workflowDefinitionSchema.parse(canvasWorkflowInput(document))
      downloadJson(value, canvas ? 'workflow.canvas.json' : 'workflow.json')
    } catch {
      setNotice(
        translate('workflows.exportFailed', 'Resolve the validation issues before exporting.')
      )
    }
  }

  const inspector = (
    <>
      <fieldset className="min-w-0" disabled={locked}>
        <WorkflowCanvasInspector
          document={document}
          node={selected}
          executionTarget={executionTarget}
          onChange={commit}
        />
      </fieldset>
      <WorkflowSelectedNodeActivity nodeId={selected?.id} snapshot={canvasSnapshot} />
    </>
  )
  return (
    <div className="workflow-canvas flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground">
      <WorkflowCanvasHeader name={document.name} saveState={state.saveState} />
      <WorkflowRunPanel
        workflowId={state.document.workflowId}
        definition={validation.success ? validation.data : undefined}
        executionTarget={executionTarget}
        run={run}
      />
      <WorkflowCanvasToolbar
        onAdd={addNode}
        onImport={() => fileInput.current?.click()}
        onExport={exportFile}
        onLayout={() => {
          commit(layoutWorkflowCanvas(document))
          requestAnimationFrame(() => {
            void flow.fitView({ padding: 0.2, duration: 0 })
          })
        }}
        onDelete={deleteSelection}
        onInspector={() => setInspectorOpen(true)}
        undo={state.undo}
        redo={state.redo}
        canUndo={!locked && state.canUndo}
        canRedo={!locked && state.canRedo}
        canDelete={!locked && canDelete}
        canAdd={!locked && document.nodes.length < 100}
        locked={locked}
        valid={validation.success}
      />
      {run.binding && (
        <WorkflowCanvasRunMode
          finished={finished}
          viewingRun={viewingRun}
          onToggle={() => setCompletedViewId(viewingRun ? null : (run.binding?.id ?? null))}
        />
      )}
      <input
        className="hidden"
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        aria-label={translate('workflows.import', 'Import JSON')}
        onChange={(event) => {
          void importFile(event.target.files?.[0])
          event.target.value = ''
        }}
      />
      {(notice || state.recovered) && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b px-4 py-2 text-xs text-destructive"
        >
          <span className="min-w-0 flex-1 break-words">
            {notice ||
              translate(
                'workflows.recovered',
                'The saved draft could not be read. A recent workflow or starter template is shown.'
              )}
          </span>
          {notice && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={translate('workflows.dismiss', 'Dismiss')}
              onClick={() => setNotice('')}
            >
              <X />
            </Button>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <WorkflowCanvasSessionContext.Provider
          value={binding && viewingRun ? openNodeSession : null}
        >
          <WorkflowCanvasGraph
            document={document}
            edges={edges}
            setDocument={setCanvasDocument}
            commit={(next, previous) => (locked ? setCanvasDocument(next) : commit(next, previous))}
            locked={locked}
            snapshot={canvasSnapshot}
            setInspectorOpen={setInspectorOpen}
          />
        </WorkflowCanvasSessionContext.Provider>
        <aside
          className="hidden w-72 shrink-0 overflow-y-auto scrollbar-sleek border-l bg-background lg:block"
          aria-label={translate('workflows.properties', 'Properties')}
        >
          {!inspectorOpen && inspector}
        </aside>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-2xs text-muted-foreground">
        <span>
          {translate('workflows.count', '{{nodes}} nodes · {{edges}} connections', {
            nodes: document.nodes.length,
            edges: document.edges.length
          })}
        </span>
        <span className="hidden flex-1 sm:block">
          {translate(
            'workflows.connectHint',
            'Drag ports to connect · Select a wire or node to delete'
          )}
        </span>
        {validation.success ? (
          <span className="flex items-center gap-1.5 text-status-success">
            <CheckCircle2 className="size-3.5" />
            {translate('workflows.valid', 'Ready to export')}
          </span>
        ) : (
          <Button
            variant="destructive-chip"
            size="xs"
            onClick={() => setIssuesOpen((value) => !value)}
          >
            {translate('workflows.issues', '{{count}} validation issues', {
              count: validation.error.issues.length
            })}
          </Button>
        )}
      </div>
      {issuesOpen && !validation.success && (
        <ul
          className="max-h-32 list-disc overflow-y-auto scrollbar-sleek border-t bg-background py-2 pr-4 pl-8 text-xs text-destructive"
          aria-label={translate('workflows.validation', 'Validation issues')}
        >
          {validation.error.issues.map((issue) => (
            <li key={`${issue.path.join('.')}:${issue.code}:${issue.message}`}>
              <span className="font-mono">{issue.path.join('.')}</span>: {issue.message}
            </li>
          ))}
        </ul>
      )}
      <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>{translate('workflows.properties', 'Properties')}</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">{inspector}</div>
        </SheetContent>
      </Sheet>
    </div>
  )
}

export default function WorkflowCanvasPage({
  executionTarget = null
}: {
  executionTarget?: WorkflowExecutionTarget | null
}) {
  const workspaceScope = executionTarget
    ? workflowWorkspaceScope(executionTarget.target, executionTarget.worktreeId)
    : undefined
  return (
    <ReactFlowProvider key={workspaceScope ?? 'global'}>
      <WorkflowCanvasEditor executionTarget={executionTarget} workspaceScope={workspaceScope} />
    </ReactFlowProvider>
  )
}
