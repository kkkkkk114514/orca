import type { WorkflowRunSnapshot } from '../../../../shared/workflow-run-contract'

export function workflowNodeExecution(id: string, snapshot: WorkflowRunSnapshot | null) {
  const execution = snapshot?.execution
  if (!execution) {
    return null
  }
  const visits = execution.steps.filter((step) => step.nodeId === id)
  const last = visits.at(-1)
  if (id === execution.cursor && execution.status !== 'running' && !execution.reason) {
    return { state: execution.status, visits: visits.length }
  }
  if (last?.report) {
    return { state: last.report.outcome, visits: visits.length }
  }
  if (last) {
    const activity = snapshot?.activity?.find((value) => value.dispatchId === last.dispatchId)
    if (activity) {
      return { state: activity.state, visits: visits.length }
    }
    return { state: 'waiting' as const, visits: visits.length }
  }
  return { state: 'pending' as const, visits: 0 }
}
