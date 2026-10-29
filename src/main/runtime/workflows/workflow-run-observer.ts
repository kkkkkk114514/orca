import { setTimeout } from 'node:timers/promises'
import { withWorkflowCheckpoint } from '../../../shared/node-workflow-checkpoint'
import { advanceWorkflow } from '../../../shared/workflow-executor'
import type { WorkflowExecution } from '../../../shared/workflow-execution'
import { saveWorkflowMetadata, type Metadata } from './workflow-run-metadata'
import { WorkflowRunReports } from './workflow-run-reports'
import type { WorkflowObservedRun } from './workflow-run-control'
import type { WorkflowRunServiceDependencies } from './workflow-run-service'

export function observeWorkflowRun(args: {
  owner: string
  paths: { directory: string; metadata: string; checkpoint: string }
  metadata: Metadata
  key: string
  active: Map<string, WorkflowObservedRun>
  dependencies: WorkflowRunServiceDependencies
  isDisposed(): boolean
  signal: AbortSignal
}) {
  const { owner, paths, metadata, key, active, dependencies, isDisposed, signal } = args
  metadata.paused = false
  metadata.error = undefined
  saveWorkflowMetadata(paths, metadata)
  const task = Promise.resolve().then(async () => {
    try {
      await withWorkflowCheckpoint(paths.checkpoint, false, async (store) => {
        const state = await store.read()
        const current = active.get(key)
        if (current) {
          current.execution = state
        }
        if (state.context.target !== owner || state.context.from !== metadata.coordinator) {
          throw new Error('Workflow coordinator identity mismatch')
        }
        const reports = new WorkflowRunReports(
          paths.directory,
          metadata.request.id,
          store.assertCurrent
        )
        const save = async (state: WorkflowExecution) => {
          await reports.synchronize(state)
          await store.save(state)
        }
        await save(state)
        if (!metadata.conversations) {
          metadata.conversations = await dependencies.resolveConversations(owner, metadata.request)
          saveWorkflowMetadata(paths, metadata)
        }
        const runtime = dependencies.createRuntime(
          store.assertCurrent,
          paths.directory,
          metadata.conversations
        )
        while (!isDisposed() && !metadata.paused && state.status === 'running') {
          const result = await advanceWorkflow(state, runtime, save, {
            shouldContinue: () => !isDisposed() && !metadata.paused
          })
          if (metadata.waiting !== (result.waiting ?? undefined)) {
            metadata.waiting = result.waiting ?? undefined
            saveWorkflowMetadata(paths, metadata)
          }
          if (state.status !== 'running' || metadata.paused || isDisposed()) {
            break
          }
          await (dependencies.wait?.(signal) ??
            setTimeout(2000, undefined, { ref: false, signal: signal }))
        }
      })
    } catch (error) {
      if (isDisposed()) {
        return
      }
      metadata.error = error instanceof Error ? error.message : String(error)
      saveWorkflowMetadata(paths, metadata)
    } finally {
      active.delete(key)
    }
  })
  active.set(key, { metadata, task, owner })
  void task.catch((error) => console.error('[workflow] could not persist run error', error))
}
