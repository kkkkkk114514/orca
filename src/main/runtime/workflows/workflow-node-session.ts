import type { OrcaRuntimeService } from '../orca-runtime'
import type {
  WorkflowHeadlessReceipts,
  WorkflowNodeSessionBinding
} from './workflow-headless-receipts'
import { isWorkflowHeadlessWorkerStartOptions } from './workflow-headless-worker-launch'
import type { WorkflowTokenUsage } from '../../../shared/workflow-step-telemetry'
import type { WorkflowResolvedConversation } from '../../../shared/workflow-node-conversation'
import { claimWorkflowConversation } from './workflow-conversation-lease'
import { assertLegacyAiVaultResumeAllowed } from '../../ai-vault/structured-session-ownership'
import type { WorkflowHeadlessAgent } from './workflow-headless-command'

export async function prepareWorkflowNodeSession(args: {
  runtime: OrcaRuntimeService
  root: string
  receipts: WorkflowHeadlessReceipts
  runId: string
  workspaceId: string
  agent: WorkflowHeadlessAgent
  configurationKey: string
  coordinator: string
  context?: { nodeId: string; previousDispatch?: string }
  selected?: WorkflowResolvedConversation
}) {
  const binding = args.context
    ? {
        runId: args.runId,
        nodeId: args.context.nodeId,
        workspaceId: args.workspaceId,
        agent: args.agent,
        configurationKey: args.configurationKey
      }
    : undefined
  const session = binding
    ? await resolveSelectedWorkflowNodeSession({
        ...args,
        binding,
        previousDispatch: args.context?.previousDispatch
      })
    : undefined
  let codexHome = session?.codexHome
  let release: (() => Promise<void>) | undefined
  try {
    if (session) {
      release = await claimWorkflowConversation(args.root, {
        agent: args.agent,
        sessionId: session.sessionId
      })
      if (
        args.selected?.transcriptPath &&
        !args.context?.previousDispatch &&
        (args.agent === 'codex' || args.agent === 'zcode')
      ) {
        const resume = {
          agent: args.agent,
          sessionId: session.sessionId,
          filePath: args.selected.transcriptPath,
          codexHome: codexHome ?? null,
          executionHostId: 'local' as const
        }
        assertLegacyAiVaultResumeAllowed(resume)
        const prepared = await args.runtime.prepareAiVaultSessionResume(resume)
        codexHome = prepared.substituteCodexHome ?? (prepared.useRealCodexHome ? null : codexHome)
      }
    }
    return { binding, session, codexHome, release }
  } catch (error) {
    await release?.()
    throw error
  }
}

export async function resolveSelectedWorkflowNodeSession(args: {
  runtime: OrcaRuntimeService
  receipts: WorkflowHeadlessReceipts
  binding: WorkflowNodeSessionBinding
  coordinator: string
  previousDispatch?: string
  selected?: WorkflowResolvedConversation
}) {
  if (args.previousDispatch) {
    return resolveWorkflowNodeSession(args)
  }
  const selected = args.selected
  if (!selected) {
    return undefined
  }
  if (selected.agent !== args.binding.agent || selected.workspaceId !== args.binding.workspaceId) {
    throw new Error('Selected conversation belongs to another agent or workspace.')
  }
  return { sessionId: selected.sessionId, usage: selected.usage, codexHome: selected.codexHome }
}

export async function resolveWorkflowNodeSession(args: {
  runtime: OrcaRuntimeService
  receipts: WorkflowHeadlessReceipts
  binding: WorkflowNodeSessionBinding
  coordinator: string
  previousDispatch?: string
}): Promise<
  { sessionId: string; usage?: WorkflowTokenUsage; codexHome?: string | null } | undefined
> {
  const priorDispatch = args.previousDispatch
  if (!priorDispatch) {
    return undefined
  }
  const db = args.runtime.getOrchestrationDb()
  const dispatch = db.getDispatchContextById(priorDispatch)
  if (
    dispatch?.run_id !== args.binding.runId ||
    !['completed', 'failed'].includes(dispatch.status)
  ) {
    throw new Error('Prior node execution does not belong to this completed workflow step.')
  }
  const worker = db.getWorkerDispatch(priorDispatch)
  if (!worker || !isWorkflowHeadlessWorkerStartOptions(JSON.parse(worker.start_options))) {
    return undefined
  }
  const resource = db.getWorkerTerminalResourceByOwner(priorDispatch)
  const previous = await args.receipts.read(priorDispatch)
  if (
    resource?.release_state !== 'released' ||
    previous.dispatchId !== priorDispatch ||
    previous.taskId !== dispatch.task_id ||
    previous.status !== 'settled' ||
    !previous.report ||
    previous.coordinator !== args.coordinator
  ) {
    throw new Error('Prior node execution is not an accepted, released worker in this workflow.')
  }
  if (!previous.binding) {
    return undefined
  }
  if (
    previous.binding.runId !== args.binding.runId ||
    previous.binding.nodeId !== args.binding.nodeId ||
    previous.binding.workspaceId !== args.binding.workspaceId ||
    previous.binding.agent !== args.binding.agent
  ) {
    throw new Error('Node session belongs to another workflow, node, agent or workspace.')
  }
  if (previous.binding.configurationKey !== args.binding.configurationKey || !previous.sessionId) {
    return undefined
  }
  return {
    sessionId: previous.sessionId,
    codexHome: previous.codexHome,
    usage:
      args.binding.agent === 'codex' ? (previous.sessionUsage ?? previous.telemetry) : undefined
  }
}
