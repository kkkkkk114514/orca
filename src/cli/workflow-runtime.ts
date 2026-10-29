import type { WorkflowRuntime } from '../shared/workflow-executor'
import { createOrchestrationWorkflowRuntime } from '../shared/workflow-orchestration-runtime'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime/types'
import { callOrchestrationMutation } from './handlers/orchestration/mutation-request'
import { isDevCliInvocation } from './handlers/orchestration/runtime-compatibility'

export function createWorkflowRuntime(
  client: RuntimeClient,
  runtimeId: string,
  assertCurrent: () => void
): WorkflowRuntime {
  return createOrchestrationWorkflowRuntime({
    runtimeId,
    assertCurrent,
    devMode: isDevCliInvocation(),
    error: (code, message) => new RuntimeClientError(code, message),
    async call(method, params, requestId) {
      return requestId
        ? (
            await callOrchestrationMutation<unknown>(
              client,
              new Map([['retry-request', requestId]]),
              method,
              params
            )
          ).result
        : (await client.call<unknown>(method, params)).result
    }
  })
}
