import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  workflowSessionPageSchema,
  type WorkflowSessionRead
} from '../../../../shared/workflow-session-view'

export async function readWorkflowSessionPage(
  target: RuntimeClientTarget,
  params: WorkflowSessionRead,
  options: { signal?: AbortSignal; workspaceId?: string } = {}
) {
  try {
    const page = workflowSessionPageSchema.parse(
      await callRuntimeRpc<unknown>(target, 'workflow.session', params, {
        signal: options.signal,
        suppressFeatureInteraction: true
      })
    )
    if (
      page.id !== params.id ||
      page.nodeId !== params.nodeId ||
      (params.dispatchId && page.dispatchId !== params.dispatchId) ||
      (options.workspaceId && page.workspaceId !== options.workspaceId)
    ) {
      throw new Error('Workflow session identity mismatch')
    }
    return page
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure)
    if (/method.not.found|unknown.method|unsupported.*method|-32601/i.test(message)) {
      throw new Error(
        translate(
          'workflows.sessionUpgradeHost',
          'Update the execution host to view workflow conversations.'
        )
      )
    }
    throw failure
  }
}
