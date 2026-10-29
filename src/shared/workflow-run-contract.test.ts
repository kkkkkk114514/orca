import { describe, expect, it } from 'vitest'
import { WorkflowRunId } from './rpc-contract/workflow-run-params'
import { workflowRunIdSchema } from './workflow-run-contract'
import { withBrowserPaneUiRuntimeRpcSource } from './runtime-rpc-feature-interaction-source'

describe('workflow status polling admission', () => {
  it('admits the existing passive UI marker while keeping unrelated fields out of run storage', () => {
    const id = '01800000-0000-4000-8000-000000000001'
    const request = withBrowserPaneUiRuntimeRpcSource({ id })
    expect(WorkflowRunId.parse(request).id).toBe(id)
    expect(WorkflowRunId.safeParse({ id, unexpected: 'value' }).success).toBe(false)
    expect(workflowRunIdSchema.safeParse(request).success).toBe(false)
  })
})
