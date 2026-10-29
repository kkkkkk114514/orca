import { observeWorkflowRun } from './workflow-run-observer'
import {
  resumeInterruptedWorkflow,
  interruptWorkflowSession,
  pauseInterruptedWorkflowRuns,
  type WorkflowObservedRun
} from './workflow-run-control'
import { mkdir } from 'node:fs/promises'
import { lock } from 'proper-lockfile'
import type { WorkflowNodeConversations } from '../../../shared/workflow-node-conversation'
import {
  loadOrCreateWorkflowMetadata,
  isMissingWorkflowFile as isMissing,
  readWorkflowMetadata,
  saveWorkflowMetadata,
  type Metadata
} from './workflow-run-metadata'
import { manageWorkflowStorage } from './workflow-run-storage'
import type { WorkflowStorageRequest } from '../../../shared/workflow-run-storage'
import { createWorkflowExecution, type WorkflowRuntime } from '../../../shared/workflow-executor'
import {
  readWorkflowCheckpoint,
  withWorkflowCheckpoint
} from '../../../shared/node-workflow-checkpoint'
import {
  workflowRunStartSchema,
  type WorkflowRunSnapshot,
  type WorkflowRunStart
} from '../../../shared/workflow-run-contract'
import type { WorkflowExecution, WorkflowStep } from '../../../shared/workflow-execution'
import type { WorkflowStepTelemetry } from '../../../shared/workflow-step-telemetry'
import type { WorkflowStepActivity } from '../../../shared/workflow-step-activity'
import { workflowRunPaths } from './workflow-report-paths'
import { readWorkflowRunSession, type WorkflowConversationReader } from './workflow-run-session'
import {
  workflowSessionReadSchema,
  workflowSessionControlSchema,
  type WorkflowSessionControl,
  type WorkflowSessionRead,
  type WorkflowSessionPage
} from '../../../shared/workflow-session-view'

type RunPaths = { directory: string; metadata: string; checkpoint: string }
type ActiveRun = WorkflowObservedRun

export type WorkflowRunServiceDependencies = {
  root: string
  headlessRoot?: string
  runtimeId: string
  createCoordinator(worktree: string, id: string, owner: string): Promise<string>
  createRuntime(
    assertCurrent: () => void,
    reportRoot?: string,
    conversations?: WorkflowNodeConversations
  ): WorkflowRuntime
  resolveConversations(owner: string, request: WorkflowRunStart): Promise<WorkflowNodeConversations>
  readTelemetry?(execution: WorkflowExecution): Promise<WorkflowStepTelemetry[]>
  readActivity?(execution: WorkflowExecution): Promise<WorkflowStepActivity[]>
  readConversation?: WorkflowConversationReader
  canControlWorker?(execution: WorkflowExecution): Promise<boolean>
  interruptWorker?(execution: WorkflowExecution, step: WorkflowStep): Promise<void>
  resumeWorker?(execution: WorkflowExecution, step: WorkflowStep, text: string): Promise<void>
  wait?: (signal: AbortSignal) => Promise<void>
}

export class WorkflowRunService {
  private readonly active = new Map<string, ActiveRun>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private disposed = false
  private readonly stopped = new AbortController()

  constructor(private readonly dependencies: WorkflowRunServiceDependencies) {}

  private paths(owner: string, id: string): RunPaths {
    return workflowRunPaths(this.dependencies.root, owner, id)
  }

  private key(owner: string, id: string): string {
    return `${owner}:${id}`
  }

  private exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    this.operations.set(key, next)
    void next
      .finally(() => {
        if (this.operations.get(key) === next) {
          this.operations.delete(key)
        }
      })
      .catch(() => {})
    return next
  }

  async start(owner: string, input: WorkflowRunStart): Promise<WorkflowRunSnapshot> {
    const request = workflowRunStartSchema.parse(input)
    return this.exclusive(this.key(owner, request.id), async () => {
      if (this.disposed) {
        throw new Error('Workflow host is shutting down')
      }
      const paths = this.paths(owner, request.id)
      await mkdir(paths.directory, { recursive: true, mode: 0o700 })
      const release = await lock(paths.directory, { realpath: false, retries: 0 })
      let metadata: Metadata | undefined
      try {
        metadata = await loadOrCreateWorkflowMetadata(paths, request, () =>
          this.dependencies.resolveConversations(owner, request)
        )
        if (!metadata.coordinator) {
          metadata.coordinator = await this.dependencies.createCoordinator(
            request.worktree,
            request.id,
            owner
          )
          saveWorkflowMetadata(paths, metadata)
        }
        const coordinator = metadata.coordinator
        let initialized = false
        try {
          await readWorkflowCheckpoint(paths.checkpoint)
        } catch (error) {
          if (!isMissing(error)) {
            throw error
          }
          await withWorkflowCheckpoint(paths.checkpoint, true, (store) =>
            store.save(
              createWorkflowExecution(
                request.definition,
                request.input,
                { worktree: request.worktree, from: coordinator, target: owner },
                this.dependencies.runtimeId
              )
            )
          )
          initialized = true
        }
        if (initialized && !this.active.has(this.key(owner, request.id))) {
          this.observe(owner, paths, metadata)
        }
      } catch (error) {
        if (metadata && JSON.stringify(metadata.request) === JSON.stringify(request)) {
          metadata.error = error instanceof Error ? error.message : String(error)
          saveWorkflowMetadata(paths, metadata)
        }
        throw error
      } finally {
        await release()
      }
      return this.show(owner, request.id)
    })
  }

  async show(owner: string, id: string): Promise<WorkflowRunSnapshot> {
    const paths = this.paths(owner, id)
    const metadata = await readWorkflowMetadata(paths)
    const execution = await readWorkflowCheckpoint(paths.checkpoint).catch((error) => {
      if (isMissing(error)) {
        return undefined
      }
      throw error
    })
    const observing = this.active.has(this.key(owner, id))
    return {
      id,
      createdAt: metadata.createdAt,
      worktree: metadata.request.worktree,
      coordinator: metadata.coordinator,
      execution,
      telemetry: execution ? await this.dependencies.readTelemetry?.(execution) : undefined,
      activity: execution ? await this.dependencies.readActivity?.(execution) : undefined,
      waiting: metadata.waiting,
      error: metadata.error,
      phase: metadata.error
        ? 'attention'
        : execution?.status === 'succeeded' || execution?.status === 'failed'
          ? execution.status
          : metadata.paused || !observing
            ? 'paused'
            : execution
              ? 'running'
              : 'starting'
    }
  }

  async session(owner: string, input: WorkflowSessionRead): Promise<WorkflowSessionPage> {
    const params = workflowSessionReadSchema.parse(input)
    const paths = this.paths(owner, params.id)
    const metadata = await readWorkflowMetadata(paths)
    const execution = await readWorkflowCheckpoint(paths.checkpoint)
    return readWorkflowRunSession({
      params,
      execution,
      owner,
      coordinator: metadata.coordinator,
      error: metadata.error,
      readConversation: this.dependencies.readConversation,
      paused: metadata.paused,
      interruption: metadata.interruption,
      interactive: Boolean(
        this.dependencies.interruptWorker &&
        this.dependencies.resumeWorker &&
        ((await this.dependencies.canControlWorker?.(execution)) ?? true)
      )
    })
  }

  async storage(owner: string, input: WorkflowStorageRequest) {
    return this.exclusive(this.key(owner, input.id), () =>
      manageWorkflowStorage(
        this.dependencies.root,
        this.dependencies.headlessRoot,
        owner,
        input,
        this.active.has(this.key(owner, input.id))
      )
    )
  }

  async control(owner: string, input: WorkflowSessionControl): Promise<WorkflowRunSnapshot> {
    const params = workflowSessionControlSchema.parse(input)
    return this.exclusive(this.key(owner, params.id), async () => {
      if (this.disposed) {
        throw new Error('Workflow host is shutting down')
      }
      if (!this.dependencies.interruptWorker || !this.dependencies.resumeWorker) {
        throw new Error('Workflow session controls are unavailable on this host')
      }
      const paths = this.paths(owner, params.id)
      const active = this.active.get(this.key(owner, params.id))
      const metadata = active?.metadata ?? (await readWorkflowMetadata(paths))
      await interruptWorkflowSession(
        {
          paths,
          owner,
          metadata,
          activeTask: active?.task,
          interruptWorker: this.dependencies.interruptWorker
        },
        params
      )
      return this.show(owner, params.id)
    })
  }

  workerInterrupted(matches: (step: WorkflowStep) => boolean) {
    pauseInterruptedWorkflowRuns(
      this.active.values(),
      matches,
      (owner, id) => this.paths(owner, id),
      (owner, input) => this.control(owner, input)
    )
  }

  async pause(owner: string, id: string): Promise<WorkflowRunSnapshot> {
    return this.exclusive(this.key(owner, id), async () => {
      const paths = this.paths(owner, id)
      const metadata =
        this.active.get(this.key(owner, id))?.metadata ?? (await readWorkflowMetadata(paths))
      metadata.paused = true
      saveWorkflowMetadata(paths, metadata)
      return this.show(owner, id)
    })
  }

  async resume(owner: string, id: string): Promise<WorkflowRunSnapshot> {
    const paths = this.paths(owner, id)
    try {
      await readWorkflowCheckpoint(paths.checkpoint)
    } catch (error) {
      if (isMissing(error)) {
        return this.start(owner, (await readWorkflowMetadata(paths)).request)
      }
      throw error
    }
    return this.exclusive(this.key(owner, id), async () => {
      if (this.disposed) {
        throw new Error('Workflow host is shutting down')
      }
      const paths = this.paths(owner, id)
      const metadata =
        this.active.get(this.key(owner, id))?.metadata ?? (await readWorkflowMetadata(paths))
      const execution = await readWorkflowCheckpoint(paths.checkpoint)
      await resumeInterruptedWorkflow(metadata, execution, this.dependencies.resumeWorker)
      metadata.paused = false
      metadata.error = undefined
      saveWorkflowMetadata(paths, metadata)
      if (!this.active.has(this.key(owner, id))) {
        this.observe(owner, paths, metadata)
      }
      return this.show(owner, id)
    })
  }

  private observe(owner: string, paths: RunPaths, metadata: Metadata): void {
    observeWorkflowRun({
      owner,
      paths,
      metadata,
      key: this.key(owner, metadata.request.id),
      active: this.active,
      dependencies: this.dependencies,
      isDisposed: () => this.disposed,
      signal: this.stopped.signal
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.stopped.abort()
    await Promise.all([...this.active.values()].map((run) => run.task))
  }
}
