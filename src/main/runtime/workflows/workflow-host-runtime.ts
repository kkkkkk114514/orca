import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createUuidV4 } from '../../../shared/uuid-v4'
import { getAppEnvironment } from '../../../shared/app-environment'
import { createOrchestrationWorkflowRuntime } from '../../../shared/workflow-orchestration-runtime'
import type { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationError } from '../orchestration/orchestration-error'
import { buildRegistry, isStreamingMethod } from '../rpc/core'
import { ORCHESTRATION_METHODS } from '../rpc/methods/orchestration'
import { TERMINAL_LIFECYCLE_METHODS } from '../rpc/methods/terminal/terminal-lifecycle-methods'
import { TERMINAL_SEND_METHODS } from '../rpc/methods/terminal/terminal-send-method'
import { isWorkflowHeadlessWorkerStartOptions } from './workflow-headless-worker-launch'
import { requireWorkerAuthority } from '../rpc/methods/orchestration/worker/worker-topology'
import { registerWorkflowInterruptListener } from './workflow-interrupt-events'
import { getOrchestrationMutationExecutor } from '../rpc/orchestration-mutation-executor'
import { WorkflowRunService } from './workflow-run-service'
import { z } from 'zod'
import type { WorkflowNodeConversations } from '../../../shared/workflow-node-conversation'
import { resolveWorkflowConversations } from './workflow-workspace-conversations'
import { claimWorkflowConversation } from './workflow-conversation-lease'
import { assertLegacyAiVaultResumeAllowed } from '../../ai-vault/structured-session-ownership'
import { isAiVaultAgent } from '../../../shared/ai-vault-types'
import { isWorkflowHeadlessAgent } from './workflow-headless-command'
import { WorkflowHeadlessWorkers } from './workflow-headless-workers'
import { WorkflowHeadlessReceipts } from './workflow-headless-receipts'
import { readWorkflowNodeConversation } from './workflow-node-conversation'

const registry = buildRegistry([
  ...ORCHESTRATION_METHODS,
  ...TERMINAL_LIFECYCLE_METHODS,
  ...TERMINAL_SEND_METHODS
])
const services = new WeakMap<OrcaRuntimeService, WorkflowRunService>()

export function getWorkflowRunService(runtime: OrcaRuntimeService): WorkflowRunService {
  const existing = services.get(runtime)
  if (existing) {
    return existing
  }
  const environment = getAppEnvironment()
  const mutations = getOrchestrationMutationExecutor(runtime)
  const terminalConversationLeases = new Map<string, () => Promise<void>>()
  const call = async (
    methodName: string,
    raw: unknown,
    requestId?: string,
    reportRoot?: string,
    conversations?: WorkflowNodeConversations
  ): Promise<unknown> => {
    const method = registry.get(methodName)
    if (!method || isStreamingMethod(method)) {
      throw new Error(`Unsupported workflow operation: ${methodName}`)
    }
    const params: unknown = method.params?.parse(raw)
    const nodeId =
      methodName === 'orchestration.workerStart'
        ? z
            .object({
              workflowNodeId: z.string().optional(),
              workflowContext: z.object({ nodeId: z.string() }).optional()
            })
            .parse(raw)
        : undefined
    const conversation =
      conversations?.[nodeId?.workflowNodeId ?? nodeId?.workflowContext?.nodeId ?? '']
    return mutations.run(
      { id: createUuidV4(), authToken: '', method: methodName, orchestrationRequestId: requestId },
      params,
      async (mutation) => {
        if (
          methodName === 'orchestration.workerStart' &&
          z.object({ agent: z.custom(isWorkflowHeadlessAgent) }).safeParse(params).success
        ) {
          return headless.start(params, mutation?.identity, reportRoot, conversation)
        }
        if (methodName === 'orchestration.workerShow') {
          await headless.inspect(z.object({ dispatch: z.string() }).parse(params).dispatch)
        }
        let releaseConversation: (() => Promise<void>) | undefined
        if (methodName === 'orchestration.workerStart' && conversation) {
          const start = z.object({ agent: z.string(), worktree: z.string() }).parse(params)
          const workspace = await runtime.showTerminalWorkspaceLaunchScope(start.worktree)
          const projectRuntime = runtime.resolveProjectRuntimeForWorktree(workspace.id)
          if (
            projectRuntime?.status === 'repair-required' ||
            (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl')
          ) {
            throw new Error(
              'Workflow conversation resume requires a native workspace on its owning host.'
            )
          }
          if (
            workspace.id !== conversation.workspaceId ||
            workspace.connectionId !== null ||
            start.agent !== conversation.agent
          ) {
            throw new Error('Selected conversation belongs to another agent or workspace.')
          }
          if (isAiVaultAgent(conversation.agent) && conversation.transcriptPath) {
            const source = {
              agent: conversation.agent,
              filePath: conversation.transcriptPath,
              sessionId: conversation.sessionId,
              codexHome: conversation.codexHome ?? null,
              executionHostId: 'local' as const
            }
            assertLegacyAiVaultResumeAllowed(source)
            await runtime.prepareAiVaultSessionResume(source)
          }
          releaseConversation = await claimWorkflowConversation(
            join(environment.getPath('userData'), 'workflow-headless'),
            conversation
          )
        }
        try {
          const result = await method.handler(params, {
            runtime,
            workflowConversation: conversation,
            recordMutationReceipt: mutation?.recordReceipt,
            markMutationEffectPossible: mutation?.markEffectPossible,
            markWorkerDoneMutationEffectFree: mutation?.markWorkerDoneEffectFree,
            orchestrationMutation: mutation?.identity,
            replayedMutationReceipt: mutation?.replayedReceipt
          })
          if (releaseConversation) {
            terminalConversationLeases.set(
              z.object({ dispatchId: z.string() }).parse(result).dispatchId,
              releaseConversation
            )
          }
          if (methodName === 'orchestration.workerRelease') {
            const dispatch = z.object({ dispatch: z.string() }).parse(params).dispatch
            if (
              /^(released|already_released)$/.test(
                z.object({ state: z.string() }).parse(result).state
              )
            ) {
              await terminalConversationLeases.get(dispatch)?.()
              terminalConversationLeases.delete(dispatch)
            }
          }
          return result
        } catch (error) {
          await releaseConversation?.()
          throw error
        }
      }
    )
  }
  const headless = new WorkflowHeadlessWorkers(
    runtime,
    join(environment.getPath('userData'), 'workflow-headless'),
    call
  )
  const service = new WorkflowRunService({
    root: join(environment.getPath('userData'), 'workflow-runs'),
    headlessRoot: join(environment.getPath('userData'), 'workflow-headless'),
    runtimeId: runtime.getRuntimeId(),
    resolveConversations: (owner, request) => resolveWorkflowConversations(runtime, owner, request),
    async canControlWorker(execution) {
      const step = execution.steps.at(-1)
      if (!step?.dispatchId || step.report || step.released) {
        return false
      }
      const worker = runtime.getOrchestrationDb().getWorkerDispatch(step.dispatchId)
      if (!worker) {
        return false
      }
      return isWorkflowHeadlessWorkerStartOptions(JSON.parse(worker.start_options))
        ? headless.canControl(step.dispatchId)
        : Boolean(worker.agent_terminal_handle)
    },
    async interruptWorker(_execution, step) {
      if (!step.dispatchId) {
        throw new Error('Workflow visit has no dispatch')
      }
      const worker = runtime.getOrchestrationDb().getWorkerDispatch(step.dispatchId)
      if (!worker) {
        throw new Error('Workflow worker not found')
      }
      if (isWorkflowHeadlessWorkerStartOptions(JSON.parse(worker.start_options))) {
        await headless.interrupt(step.dispatchId)
        return
      }
      const resource = runtime
        .getOrchestrationDb()
        .getWorkerTerminalResourceByOwner(step.dispatchId)
      if (resource?.ownership_state !== 'owned' || !worker.agent_terminal_handle) {
        throw new Error('Workflow worker terminal is no longer owned')
      }
      requireWorkerAuthority(runtime, worker.agent_terminal_handle)
      if ((await runtime.getTerminalAgentStatus(worker.agent_terminal_handle)).isRunningAgent) {
        await call('terminal.send', { terminal: worker.agent_terminal_handle, text: '\x1b' })
      }
    },
    async resumeWorker(_execution, step, text) {
      if (!step.dispatchId) {
        throw new Error('Workflow visit has no dispatch')
      }
      const worker = runtime.getOrchestrationDb().getWorkerDispatch(step.dispatchId)
      if (!worker) {
        throw new Error('Workflow worker not found')
      }
      if (isWorkflowHeadlessWorkerStartOptions(JSON.parse(worker.start_options))) {
        await headless.resume(step.dispatchId, text)
        return
      }
      const resource = runtime
        .getOrchestrationDb()
        .getWorkerTerminalResourceByOwner(step.dispatchId)
      if (resource?.ownership_state !== 'owned' || !worker.agent_terminal_handle) {
        throw new Error('Workflow worker terminal is no longer owned')
      }
      requireWorkerAuthority(runtime, worker.agent_terminal_handle)
      if (!(await runtime.getTerminalAgentStatus(worker.agent_terminal_handle)).isRunningAgent) {
        throw new Error(
          'The interrupted CLI is no longer running in its terminal. Resume was not sent to the shell.'
        )
      }
      await call(
        'terminal.send',
        {
          terminal: worker.agent_terminal_handle,
          text: `Continue your interrupted workflow assignment and return its required completion report. User supplements (JSON): ${JSON.stringify(text)}`,
          enter: true,
          agentPrompt: true
        },
        createUuidV4()
      )
    },
    readConversation: (execution, step, before) =>
      readWorkflowNodeConversation(
        new WorkflowHeadlessReceipts(join(environment.getPath('userData'), 'workflow-headless')),
        execution,
        step,
        before
      ),
    readActivity: (execution) =>
      headless.activity(
        execution.steps.flatMap((step) => (step.dispatchId ? [step.dispatchId] : []))
      ),
    readTelemetry: (execution) =>
      headless.telemetry(
        execution.steps.flatMap((step) => (step.dispatchId ? [step.dispatchId] : []))
      ),
    async createCoordinator(worktree, id, owner) {
      const result = await call('terminal.create', {
        worktree,
        clientMutationId: createHash('sha256').update(`${owner}:${id}`).digest('hex'),
        reconcileExisting: true,
        title: 'Workflow coordinator',
        focus: false,
        activate: false,
        presentation: 'background'
      })
      return z.object({ terminal: z.object({ handle: z.string().min(1) }) }).parse(result).terminal
        .handle
    },
    createRuntime(assertCurrent, reportRoot, conversations) {
      return createOrchestrationWorkflowRuntime({
        runtimeId: runtime.getRuntimeId(),
        assertCurrent,
        call: (method, params, requestId) =>
          call(method, params, requestId, reportRoot, conversations),
        devMode: !environment.isPackaged(),
        nativeNodeLaunch: true,
        error: (code, message) => new OrchestrationError(code, message)
      })
    }
  })
  const unregisterInterrupt = registerWorkflowInterruptListener(runtime, (handle) => {
    service.workerInterrupted((step) =>
      Boolean(
        step.dispatchId &&
        runtime.getOrchestrationDb().getWorkerDispatch(step.dispatchId)?.agent_terminal_handle ===
          handle
      )
    )
  })
  environment.onWillQuit(() => {
    unregisterInterrupt()
    void service.dispose()
    void headless.dispose()
  })
  services.set(runtime, service)
  return service
}
