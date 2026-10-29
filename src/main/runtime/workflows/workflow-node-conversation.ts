import { workflowJournalCleared } from './workflow-run-storage'
import { readNativeChatTranscriptTail } from '../../native-chat/transcript-tail-reader'
import { publicMessage } from './public-session-message'
import type { WorkflowExecution, WorkflowStep } from '../../../shared/workflow-execution'
import type { WorkflowSessionPage } from '../../../shared/workflow-session-view'
import type { WorkflowHeadlessReceipts } from './workflow-headless-receipts'
import { readWorkflowSessionJournal } from './workflow-session-journal'

type Conversation = Pick<
  WorkflowSessionPage,
  'entries' | 'source' | 'before' | 'hasMore' | 'limited' | 'cleared'
>

export async function readWorkflowNodeConversation(
  receipts: WorkflowHeadlessReceipts,
  execution: WorkflowExecution,
  step: WorkflowStep,
  before?: number
): Promise<Conversation> {
  const empty: Conversation = {
    entries: [],
    source: 'unavailable',
    before: 0,
    hasMore: false,
    limited: false
  }
  if (!step.dispatchId) {
    return empty
  }
  let saved
  try {
    saved = await receipts.read(step.dispatchId)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return empty
    }
    throw error
  }
  const node = execution.definition.nodes.find((candidate) => candidate.id === step.nodeId)
  const binding = saved.binding
  if (
    node?.type !== 'agent' ||
    !binding ||
    binding.runId !== execution.runId ||
    binding.nodeId !== step.nodeId ||
    binding.agent !== node.agent ||
    `id:${binding.workspaceId}` !== execution.context.worktree ||
    saved.dispatchId !== step.dispatchId ||
    saved.taskId !== step.taskId ||
    saved.coordinator !== execution.context.from
  ) {
    throw new Error('Workflow session binding mismatch')
  }

  if (await workflowJournalCleared(receipts.path(step.dispatchId))) {
    return { ...empty, cleared: true }
  }
  const journal = await readWorkflowSessionJournal(
    `${receipts.path(step.dispatchId)}.conversation.jsonl`,
    before
  )
  const legacyJournal =
    journal && saved.status === 'settled' && !journal.entries.some((entry) => entry.blocks?.length)
  if (journal && !legacyJournal) {
    return { ...journal, source: 'journal' }
  }
  if (saved.sessionId && (binding.agent === 'codex' || binding.agent === 'zcode')) {
    const transcript = await readNativeChatTranscriptTail({
      agent: binding.agent,
      sessionId: saved.sessionId,
      limit: 50,
      beforeOffset: before
    })
    if (!('error' in transcript)) {
      const entries = transcript.messages.flatMap(publicMessage)
      return {
        entries,
        source: 'transcript',
        hasMore: transcript.hasMore,
        before: transcript.beforeOffset,
        limited: entries.some((entry) => entry.limited)
      }
    }
  }
  if (journal) {
    return { ...journal, source: 'journal', limited: true }
  }
  const activity = await receipts.readActivity(step.dispatchId)
  return activity
    ? {
        entries: activity.entries.map((entry) => ({
          ...entry,
          id: String(entry.id),
          role: 'activity' as const
        })),
        source: 'activity',
        before: 0,
        hasMore: false,
        limited: true
      }
    : empty
}
