import type { WorkflowDefinition, WorkflowNode } from './workflow-definition'
import { createUuidV4 } from './uuid-v4'
import {
  workflowExecutionSchema,
  type WorkflowExecution,
  type WorkflowStep,
  type WorkflowStepReport
} from './workflow-execution'

export type WorkflowRuntime = {
  runtimeId: string
  createRun(state: WorkflowExecution): Promise<string>
  startStep(
    state: WorkflowExecution,
    step: WorkflowStep,
    node: Extract<WorkflowNode, { type: 'agent' }>
  ): Promise<{ taskId: string; dispatchId: string }>
  inspectStep(
    state: WorkflowExecution,
    step: WorkflowStep
  ): Promise<{ report: WorkflowStepReport } | { waiting: string }>
  releaseStep(step: WorkflowStep): Promise<boolean>
}

export function createWorkflowExecution(
  definition: WorkflowDefinition,
  input: string,
  context: WorkflowExecution['context'],
  runtimeId: string
): WorkflowExecution {
  return workflowExecutionSchema.parse({
    version: 1,
    definition,
    input,
    context,
    runRequestId: createUuidV4(),
    runRuntimeId: runtimeId,
    cursor: definition.entry,
    status: 'running',
    steps: []
  })
}

export async function advanceWorkflow(
  state: WorkflowExecution,
  runtime: WorkflowRuntime,
  save: (state: WorkflowExecution) => Promise<void>,
  options: { shouldContinue?: () => boolean } = {}
): Promise<{ state: WorkflowExecution; waiting: string | null }> {
  if (state.status !== 'running') {
    return { state, waiting: null }
  }
  if (!state.runId) {
    assertSamePendingRuntime(state.runRuntimeId, runtime.runtimeId)
    await save(state)
    state.runId = await runtime.createRun(state)
    await save(state)
  }
  while (state.status === 'running') {
    if (options.shouldContinue?.() === false) {
      return {
        state,
        waiting: 'Scheduling paused. An already started worker may still be running.'
      }
    }
    const node = state.definition.nodes.find((candidate) => candidate.id === state.cursor)
    if (!node) {
      throw new Error('Workflow cursor does not name a node')
    }
    if (node.type === 'end') {
      state.status = node.outcome
      await save(state)
      break
    }
    let step = state.steps.at(-1)
    if (!step || step.released) {
      if (state.steps.length >= state.definition.maxSteps) {
        state.status = 'failed'
        state.reason = 'step_limit'
        await save(state)
        break
      }
      step = {
        nodeId: node.id,
        startRequestId: createUuidV4(),
        startRuntimeId: runtime.runtimeId,
        releaseRequestId: createUuidV4(),
        released: false
      }
      state.steps.push(step)
      await save(state)
    }
    if (!step.dispatchId) {
      assertSamePendingRuntime(step.startRuntimeId, runtime.runtimeId)
      const started = await runtime.startStep(state, step, node)
      step.taskId = started.taskId
      step.dispatchId = started.dispatchId
      await save(state)
    }
    if (!step.report) {
      const observation = await runtime.inspectStep(state, step)
      if ('waiting' in observation) {
        return { state, waiting: observation.waiting }
      }
      step.report = observation.report
      await save(state)
    }
    if (options.shouldContinue?.() === false) {
      return { state, waiting: 'Workflow paused before accepting the next transition.' }
    }
    if (!(await runtime.releaseStep(step))) {
      return { state, waiting: 'Worker resource release requires attention; no next step started.' }
    }
    step.released = true
    state.cursor = step.report.outcome === 'succeeded' ? node.onSuccess : node.onFailure
    await save(state)
  }
  return { state, waiting: null }
}

function assertSamePendingRuntime(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new Error(
      'The runtime changed during an unrecorded mutation. Inspect its saved request ID before recovering; a fresh worker will not be started.'
    )
  }
}
