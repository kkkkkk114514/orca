import type { WorkflowExecution, WorkflowStep } from '../../../shared/workflow-execution'
import type {
  WorkflowSessionPage,
  WorkflowSessionRead
} from '../../../shared/workflow-session-view'
import { boundWorkflowSessionPage } from './workflow-session-page-bounds'
import type { Metadata } from './workflow-run-metadata'

export type WorkflowConversationReader = (
  execution: WorkflowExecution,
  step: WorkflowStep,
  before?: number
) => Promise<
  Pick<WorkflowSessionPage, 'entries' | 'source' | 'before' | 'hasMore' | 'limited' | 'cleared'>
>

export async function readWorkflowRunSession(args: {
  params: WorkflowSessionRead
  execution: WorkflowExecution
  owner: string
  coordinator?: string
  error?: string
  paused?: boolean
  interruption?: Metadata['interruption']
  interactive?: boolean
  readConversation?: WorkflowConversationReader
}): Promise<WorkflowSessionPage> {
  const { params, execution } = args
  if (execution.context.target !== args.owner || execution.context.from !== args.coordinator) {
    throw new Error('Workflow coordinator identity mismatch')
  }
  const node = execution.definition.nodes.find((candidate) => candidate.id === params.nodeId)
  if (node?.type !== 'agent') {
    throw new Error('Workflow agent node does not exist')
  }
  const visits = execution.steps.filter((step) => step.nodeId === params.nodeId && step.dispatchId)
  const step = params.dispatchId
    ? visits.find((visit) => visit.dispatchId === params.dispatchId)
    : visits.at(-1)
  if (!step?.dispatchId) {
    throw new Error('Workflow node has no matching dispatched visit')
  }
  const page = await args.readConversation?.(execution, step, params.before)
  return boundWorkflowSessionPage({
    id: params.id,
    nodeId: params.nodeId,
    workspaceId: execution.context.worktree.replace(/^id:/, ''),
    agent: node.agent,
    dispatchId: step.dispatchId,
    visits: visits.flatMap((visit) =>
      visit.dispatchId
        ? [
            {
              dispatchId: visit.dispatchId,
              outcome:
                visit.report?.outcome ??
                (args.error || args.interruption?.dispatchId === visit.dispatchId
                  ? ('interrupted' as const)
                  : ('running' as const))
            }
          ]
        : []
    ),
    entries: page?.entries ?? [],
    source: page?.source ?? 'unavailable',
    hasMore: page?.hasMore ?? false,
    before: page?.before ?? 0,
    limited: page?.limited ?? false,
    cleared: page?.cleared,
    control:
      args.interactive &&
      execution.status === 'running' &&
      execution.steps.at(-1)?.dispatchId === step.dispatchId &&
      !step.report &&
      !step.released
        ? { paused: args.paused ?? false, pendingMessages: args.interruption?.messages ?? [] }
        : undefined,
    report: step.report?.body,
    task: execution.input,
    instructions: node.prompt
  })
}
