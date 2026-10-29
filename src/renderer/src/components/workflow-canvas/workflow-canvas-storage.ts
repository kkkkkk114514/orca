import { workflowDefinitionSchema } from '../../../../shared/workflow-definition'
import {
  canvasWorkflowInput,
  createWorkflowCanvasTemplate,
  importWorkflowCanvas,
  workflowCanvasDocumentSchema,
  type WorkflowCanvasDocument
} from './workflow-canvas-document'
import { workflowScopedStorageKey } from './workflow-workspace-scope'

const draftKey = 'orca.workflow-canvas.v1'
const latestKey = 'orca.workflow-canvas.latest-valid.v1'
const usedKey = 'orca.workflow-canvas.last-used.v1'

export function readWorkflowCanvasDraft(scope?: string): {
  document: WorkflowCanvasDocument
  recovered: boolean
} {
  let recovered = false
  const keys = scope
    ? [
        workflowScopedStorageKey(draftKey, scope),
        workflowScopedStorageKey(usedKey, scope),
        latestKey,
        draftKey
      ]
    : [draftKey]
  for (const key of keys) {
    try {
      const saved = localStorage.getItem(key)
      if (!saved) {
        continue
      }
      const document = importWorkflowCanvas(JSON.parse(saved))
      if (
        scope &&
        (key === latestKey || key === draftKey) &&
        !workflowDefinitionSchema.safeParse(canvasWorkflowInput(document)).success
      ) {
        continue
      }
      return { document, recovered }
    } catch {
      recovered = true
    }
  }
  return { document: createWorkflowCanvasTemplate(), recovered }
}

export function saveWorkflowCanvasDraft(
  document: WorkflowCanvasDocument,
  scope?: string,
  publish = true
): void {
  const parsed = workflowCanvasDocumentSchema.parse(document)
  const saved = JSON.stringify(parsed)
  localStorage.setItem(workflowScopedStorageKey(draftKey, scope), saved)
  if (scope && publish) {
    localStorage.setItem(draftKey, saved)
  }
  if (publish && workflowDefinitionSchema.safeParse(canvasWorkflowInput(document)).success) {
    localStorage.setItem(latestKey, saved)
  }
}

export function rememberWorkflowCanvasUsed(scope: string, document: WorkflowCanvasDocument): void {
  localStorage.setItem(
    workflowScopedStorageKey(usedKey, scope),
    JSON.stringify(workflowCanvasDocumentSchema.parse(document))
  )
}
