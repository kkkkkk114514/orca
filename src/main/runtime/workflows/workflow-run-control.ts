import type { WorkflowExecution, WorkflowStep } from '../../../shared/workflow-execution'
import type { WorkflowSessionControl } from '../../../shared/workflow-session-view'
import { readWorkflowCheckpoint } from '../../../shared/node-workflow-checkpoint'
import { saveWorkflowMetadata, type Metadata } from './workflow-run-metadata'

export type WorkflowObservedRun = {
  metadata: Metadata
  task: Promise<void>
  execution?: WorkflowExecution
  owner: string
}
type Paths = { metadata: string; checkpoint: string }

export async function interruptWorkflowSession(
  args: {
    paths: Paths
    owner: string
    metadata: Metadata
    activeTask?: Promise<void>
    interruptWorker(execution: WorkflowExecution, step: WorkflowStep): Promise<void>
  },
  params: WorkflowSessionControl
) {
  const { paths, owner, metadata, activeTask, interruptWorker } = args
  const validate = (state: WorkflowExecution) => {
    const step = state.steps.at(-1)
    if (
      state.context.target !== owner ||
      state.context.from !== metadata.coordinator ||
      state.status !== 'running' ||
      !step ||
      step.nodeId !== params.nodeId ||
      step.dispatchId !== params.dispatchId ||
      step.released ||
      step.report
    ) {
      throw new Error(
        'Only the current unfinished workflow visit can be interrupted or receive messages'
      )
    }
    return step
  }
  validate(await readWorkflowCheckpoint(paths.checkpoint))
  if (metadata.interruption?.messages.some((message) => message.id === params.requestId)) {
    return undefined
  }
  if (params.text && (metadata.interruption?.messages.length ?? 0) >= 100) {
    throw new Error('Resume the node before adding more messages')
  }
  metadata.paused = true
  saveWorkflowMetadata(paths, metadata)
  await activeTask
  const execution = await readWorkflowCheckpoint(paths.checkpoint)
  const step = validate(execution)
  metadata.error = undefined
  metadata.interruption ??= {
    nodeId: params.nodeId,
    dispatchId: params.dispatchId,
    messages: []
  }
  saveWorkflowMetadata(paths, metadata)
  await interruptWorker(execution, step)
  if (params.text) {
    metadata.interruption.messages.push({ id: params.requestId, text: params.text })
  }
  saveWorkflowMetadata(paths, metadata)
}

export function pauseInterruptedWorkflowRuns(
  runs: Iterable<WorkflowObservedRun>,
  matches: (step: WorkflowStep) => boolean,
  paths: (owner: string, id: string) => Paths,
  control: (owner: string, input: WorkflowSessionControl) => Promise<unknown>
) {
  for (const active of runs) {
    const step = active.execution?.steps.at(-1)
    if (
      !step?.dispatchId ||
      step.report ||
      step.released ||
      active.metadata.paused ||
      !matches(step)
    ) {
      continue
    }
    active.metadata.paused = true
    saveWorkflowMetadata(paths(active.owner, active.metadata.request.id), active.metadata)
    void control(active.owner, {
      id: active.metadata.request.id,
      nodeId: step.nodeId,
      dispatchId: step.dispatchId,
      requestId: step.startRequestId,
      action: 'interrupt'
    }).catch((error) => {
      active.metadata.error = error instanceof Error ? error.message : String(error)
      saveWorkflowMetadata(paths(active.owner, active.metadata.request.id), active.metadata)
    })
  }
}

export async function resumeInterruptedWorkflow(
  metadata: Metadata,
  execution: WorkflowExecution,
  resumeWorker?: (execution: WorkflowExecution, step: WorkflowStep, text: string) => Promise<void>
) {
  if (metadata.interruption) {
    const step = execution.steps.at(-1)
    if (
      !step ||
      step.dispatchId !== metadata.interruption.dispatchId ||
      step.nodeId !== metadata.interruption.nodeId
    ) {
      throw new Error('Interrupted workflow visit changed')
    }
    if (!step.report && !step.released) {
      if (!resumeWorker) {
        throw new Error('Workflow session resume is unavailable on this host')
      }
      await resumeWorker(
        execution,
        step,
        metadata.interruption.messages.map((message) => message.text).join('\n\n')
      )
    }
    metadata.interruption = undefined
  }
}
