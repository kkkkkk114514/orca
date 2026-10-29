import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { getAppEnvironment } from '../../../shared/app-environment'
import { isAiVaultSessionResumableContent } from '../../../shared/ai-vault-types'
import { isResumableTuiAgent } from '../../../shared/agent-session-resume'
import { getAiVaultAgentProviderSession } from '../../../shared/ai-vault-resume-startup'
import { assertLegacyAiVaultResumeAllowed } from '../../ai-vault/structured-session-ownership'
import {
  loadWorkspaceSessionHistory,
  type WorkspaceHistoryRuntime
} from './workspace-session-history'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { WorkspaceHistoryItem } from './workspace-session-inventory'
import { WorkflowHeadlessReceipts } from './workflow-headless-receipts'
import { workflowRunPaths } from './workflow-report-paths'
import { readWorkflowMetadata } from './workflow-run-metadata'
import { readWorkflowCheckpoint } from '../../../shared/node-workflow-checkpoint'
import {
  workflowResolvedConversationSchema,
  type WorkflowNodeConversations,
  type WorkflowResolvedConversation
} from '../../../shared/workflow-node-conversation'
import type { WorkflowRunStart } from '../../../shared/workflow-run-contract'
import type { TuiAgent } from '../../../shared/tui-agent'
import { isWorkflowConversationBusy } from './workflow-conversation-lease'

export async function resolveWorkspaceHistoryConversation(args: {
  item: WorkspaceHistoryItem
  owner: string
  workspace: { id: string; path: string }
  runRoot: string
  receipts: WorkflowHeadlessReceipts
}) {
  const { item, workspace } = args
  if (!isResumableTuiAgent(item.row.agent)) {
    return undefined
  }
  const identity = (sessionId: string) => ({
    key: createHash('sha256')
      .update(JSON.stringify([workspace.id, item.row.agent, sessionId]))
      .digest('hex'),
    agent: item.row.agent,
    workspaceId: workspace.id
  })
  if (item.native) {
    if (
      item.native.agent !== item.row.agent ||
      item.native.executionHostId !== 'local' ||
      item.native.subagent ||
      ![item.native.cwd, ...(item.native.cwdAliases ?? [])].some(
        (cwd) =>
          cwd &&
          normalizeRuntimePathForComparison(cwd) ===
            normalizeRuntimePathForComparison(workspace.path)
      )
    ) {
      throw new Error('Conversation does not belong to this local workspace and agent.')
    }
    if (
      !isAiVaultSessionResumableContent(item.native) ||
      !getAiVaultAgentProviderSession(item.native)
    ) {
      return undefined
    }
    assertLegacyAiVaultResumeAllowed(item.native)
    return workflowResolvedConversationSchema.parse({
      ...identity(item.native.sessionId),
      sessionId: item.native.sessionId,
      transcriptPath: item.native.filePath,
      codexHome: item.native.codexHome ?? undefined
    })
  }
  if (!item.row.workflow) {
    return undefined
  }
  const paths = workflowRunPaths(args.runRoot, args.owner, item.row.workflow.id)
  const metadata = await readWorkflowMetadata(paths)
  const execution = await readWorkflowCheckpoint(paths.checkpoint)
  if (
    metadata.request.worktree !== `id:${workspace.id}` ||
    execution.context.target !== args.owner ||
    execution.context.from !== metadata.coordinator ||
    execution.context.worktree !== metadata.request.worktree
  ) {
    throw new Error('Conversation does not belong to this workspace and caller.')
  }
  const nodeId = item.row.workflow.nodeId
  const node = execution.definition.nodes.find((entry) => entry.id === nodeId)
  if (node?.type !== 'agent' || node.agent !== item.row.agent) {
    throw new Error('Conversation agent identity changed.')
  }
  const step = execution.steps.findLast(
    (entry) => entry.nodeId === nodeId && entry.released && entry.report && entry.dispatchId
  )
  if (!step?.dispatchId) {
    return undefined
  }
  const saved = await args.receipts.read(step.dispatchId)
  if (
    !saved.sessionId ||
    saved.status !== 'settled' ||
    !saved.report ||
    saved.dispatchId !== step.dispatchId ||
    saved.taskId !== step.taskId ||
    saved.coordinator !== execution.context.from ||
    !saved.binding ||
    saved.binding.runId !== execution.runId ||
    saved.binding.nodeId !== nodeId ||
    saved.binding.agent !== node.agent ||
    saved.binding.workspaceId !== workspace.id
  ) {
    return undefined
  }
  return workflowResolvedConversationSchema.parse({
    ...identity(saved.sessionId),
    sessionId: saved.sessionId,
    codexHome: saved.codexHome,
    usage: node.agent === 'codex' ? (saved.sessionUsage ?? saved.telemetry) : undefined
  })
}

export async function listWorkflowConversations(
  runtime: WorkspaceHistoryRuntime,
  owner: string,
  worktree: string,
  agent?: TuiAgent,
  force = true
) {
  const root = getAppEnvironment().getPath('userData')
  const history = await loadWorkspaceSessionHistory(runtime, owner, { worktree, force })
  const receipts = new WorkflowHeadlessReceipts(join(root, 'workflow-headless'))
  const choices: {
    row: WorkspaceHistoryItem['row']
    history: WorkspaceHistoryItem['row']
    conversation: WorkflowResolvedConversation
  }[] = []
  const seen = new Set<string>()
  const issues = [...history.issues]
  for (const item of history.items) {
    if (agent && item.row.agent !== agent) {
      continue
    }
    try {
      const conversation = await resolveWorkspaceHistoryConversation({
        item,
        owner,
        workspace: history.workspace,
        receipts,
        runRoot: join(root, 'workflow-runs')
      })
      if (
        conversation &&
        !history.busySessions.has(`${conversation.agent}:${conversation.sessionId}`) &&
        !seen.has(conversation.key) &&
        !(await isWorkflowConversationBusy(join(root, 'workflow-headless'), conversation))
      ) {
        seen.add(conversation.key)
        choices.push({
          row: { ...item.row, key: conversation.key },
          history: item.row,
          conversation
        })
      }
    } catch (error) {
      if (issues.length < 10) {
        issues.push(error instanceof Error ? error.message : String(error))
      }
    }
  }
  return { workspace: history.workspace, choices, issues: issues.slice(0, 10) }
}

export async function resolveWorkflowConversations(
  runtime: WorkspaceHistoryRuntime,
  owner: string,
  request: WorkflowRunStart
): Promise<WorkflowNodeConversations> {
  const nodes = request.definition.nodes.filter(
    (node) => node.type === 'agent' && node.conversation?.mode !== 'new'
  )
  if (!nodes.length) {
    return {}
  }
  const history = await listWorkflowConversations(runtime, owner, request.worktree)
  const result: WorkflowNodeConversations = {}
  for (const node of nodes) {
    if (node.type !== 'agent') {
      continue
    }
    const selection = node.conversation
    const choice =
      selection?.mode === 'existing'
        ? history.choices.find(
            (item) => item.row.key === selection.key && item.row.agent === node.agent
          )
        : history.choices.find((item) => item.row.agent === node.agent && !item.row.archived)
    if (selection?.mode === 'existing' && !choice) {
      throw new Error(
        `Selected conversation for node ${node.id} is unavailable, in use, or belongs to another agent or workspace. Choose another conversation or start new.`
      )
    }
    if (choice) {
      result[node.id] = choice.conversation
    }
  }
  return result
}
