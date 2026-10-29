import { defineMethod, type RpcContext } from '../core'
import { rpcCallerOperationKey } from '../rpc-caller-identity'
import { getWorkflowRunService } from '../../workflows/workflow-host-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { getWorkflowNodeOptions } from '../../workflows/workflow-node-options'
import { listWorkflowConversations } from '../../workflows/workflow-workspace-conversations'
import { isResumableTuiAgent } from '../../../../shared/agent-session-resume'
import {
  WorkflowConversationsParams,
  WorkflowStorage,
  WorkflowRunId,
  WorkflowSessionRead,
  WorkflowSessionControl,
  WorkflowNodeOptionsParams,
  WorkflowRunStart
} from '../../../../shared/rpc-contract/workflow-run-params'

export function workflowCallerOwner(context: RpcContext): string {
  if (
    !context.caller ||
    context.orchestrationCaller ||
    context.orchestrationCompatibilityEvidence
  ) {
    throw new OrchestrationError(
      'consumer_fenced',
      'Open the workflow canvas from an authenticated client to control a workflow run.'
    )
  }
  return rpcCallerOperationKey(context.caller)
}

export const WORKFLOW_RUN_METHODS = [
  defineMethod({
    name: 'workflow.sessionControl',
    permission: 'workspace',
    params: WorkflowSessionControl,
    handler: (params, context) =>
      getWorkflowRunService(context.runtime).control(workflowCallerOwner(context), params)
  }),
  defineMethod({
    name: 'workflow.conversations',
    permission: 'workspace',
    params: WorkflowConversationsParams,
    async handler(params, context) {
      const result = await listWorkflowConversations(
        context.runtime,
        workflowCallerOwner(context),
        params.worktree,
        params.agent,
        params.force ?? false
      )
      return {
        supported: isResumableTuiAgent(params.agent),
        rows: result.choices.slice(0, 2000).map(({ row, history }) => ({
          key: row.key,
          title: row.title,
          updatedAt: row.updatedAt,
          archived: row.archived,
          history
        })),
        issues: result.issues
      }
    }
  }),
  defineMethod({
    name: 'workflow.storage',
    permission: 'workspace',
    params: WorkflowStorage,
    handler: (params, context) =>
      getWorkflowRunService(context.runtime).storage(workflowCallerOwner(context), params)
  }),
  defineMethod({
    name: 'workflow.session',
    permission: 'workspace',
    params: WorkflowSessionRead,
    handler: (params, context) =>
      getWorkflowRunService(context.runtime).session(workflowCallerOwner(context), params)
  }),
  defineMethod({
    name: 'workflow.nodeOptions',
    permission: 'workspace',
    params: WorkflowNodeOptionsParams,
    handler: (params, { runtime, signal }) => getWorkflowNodeOptions(runtime, params, signal)
  }),
  defineMethod({
    name: 'workflow.start',
    permission: 'workspace',
    params: WorkflowRunStart,
    async handler(params, context) {
      const caller = workflowCallerOwner(context)
      const workspace = await context.runtime.showTerminalWorkspaceLaunchScope(params.worktree)
      return getWorkflowRunService(context.runtime).start(caller, {
        ...params,
        worktree: `id:${workspace.id}`
      })
    }
  }),
  defineMethod({
    name: 'workflow.show',
    permission: 'workspace',
    params: WorkflowRunId,
    handler: (params, context) =>
      getWorkflowRunService(context.runtime).show(workflowCallerOwner(context), params.id)
  }),
  defineMethod({
    name: 'workflow.pause',
    permission: 'workspace',
    params: WorkflowRunId,
    handler: (params, context) =>
      getWorkflowRunService(context.runtime).pause(workflowCallerOwner(context), params.id)
  }),
  defineMethod({
    name: 'workflow.resume',
    permission: 'workspace',
    params: WorkflowRunId,
    handler: (params, context) =>
      getWorkflowRunService(context.runtime).resume(workflowCallerOwner(context), params.id)
  })
]
