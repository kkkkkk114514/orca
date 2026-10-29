import { join } from 'node:path'
import { z } from 'zod'
import { getAppEnvironment } from '../../../shared/app-environment'
import { WorkspaceSessionArchive as ArchiveStore } from './workspace-session-archive'
import { workspaceSessionInventory } from './workspace-session-inventory'
import { WorkflowHeadlessReceipts } from './workflow-headless-receipts'
import type { AiVaultListArgs, AiVaultListResult } from '../../../shared/ai-vault-types'
import type {
  WorkspaceSessionsList,
  WorkspaceSessionSelect
} from '../../../shared/workspace-session-history'
import { readNativeChatTranscriptTail } from '../../native-chat/transcript-tail-reader'
import { publicMessage } from './public-session-message'
import { redactString } from '../../observability/redactor'
import type { WorkflowSessionEntry } from '../../../shared/workflow-session-view'
import { boundSessionRecordEntry } from './session-record-entry-bounds'

export type WorkspaceHistoryRuntime = {
  showTerminalWorkspaceLaunchScope(
    worktree: string
  ): Promise<{ id: string; path: string; connectionId: string | null }>
  listAiVaultSessions(
    args?: AiVaultListArgs
  ): Promise<Pick<AiVaultListResult, 'sessions' | 'issues'>>
}
const inventories = new WeakMap<
  WorkspaceHistoryRuntime,
  Map<string, { expires: number; value: ReturnType<typeof discoverHistory> }>
>()
async function discoverHistory(
  runtime: WorkspaceHistoryRuntime,
  owner: string,
  workspace: { id: string; path: string },
  force?: boolean
) {
  const userData = getAppEnvironment().getPath('userData')
  const native = await runtime
    .listAiVaultSessions({
      limit: 2000,
      scopePaths: [workspace.path],
      force
    })
    .catch((error) => ({
      sessions: [],
      issues: [{ message: error instanceof Error ? error.message : String(error) }]
    }))
  const inventory = await workspaceSessionInventory({
    root: join(userData, 'workflow-runs'),
    owner,
    workspace,
    native: native.sessions,
    receipts: new WorkflowHeadlessReceipts(join(userData, 'workflow-headless'))
  })
  return {
    ...inventory,
    issues: [
      ...inventory.issues,
      ...native.issues.map((issue) => issue.message.slice(0, 500)),
      ...(native.sessions.length >= 2000
        ? ['Native conversation discovery reached its 2,000-session limit.']
        : [])
    ].slice(0, 10)
  }
}

export async function loadWorkspaceSessionHistory(
  runtime: WorkspaceHistoryRuntime,
  owner: string,
  input: z.infer<typeof WorkspaceSessionsList>
) {
  const workspace = z
    .object({ id: z.string(), path: z.string(), connectionId: z.string().nullable() })
    .parse(await runtime.showTerminalWorkspaceLaunchScope(input.worktree))
  if (workspace.connectionId !== null) {
    throw new Error(
      'Read session history on the workspace owning host; direct SSH history is unavailable.'
    )
  }
  const userData = getAppEnvironment().getPath('userData')
  const archive = new ArchiveStore(join(userData, 'workspace-session-history'))
  let cache = inventories.get(runtime)
  if (!cache) {
    cache = new Map()
    inventories.set(runtime, cache)
  }
  const cacheKey = JSON.stringify([owner, workspace.id])
  let cached = cache.get(cacheKey)
  if (!cached || cached.expires < Date.now() || input.force) {
    if (cache.size >= 100) {
      cache.delete(cache.keys().next().value ?? '')
    }
    cached = {
      expires: Date.now() + 15_000,
      value: discoverHistory(runtime, owner, workspace, input.force)
    }
    cache.set(cacheKey, cached)
    void cached.value.catch(() => {
      if (cache.get(cacheKey) === cached) {
        cache.delete(cacheKey)
      }
    })
  }
  const inventory = await cached.value
  const archived = await archive.read(owner, workspace.id)
  const items = inventory.items.map((item) => ({
    ...item,
    row: { ...item.row, archived: archived[item.row.key] !== undefined }
  }))
  return {
    workspace,
    archive,
    items,
    issues: inventory.issues,
    busySessions: inventory.busySessions
  }
}

export async function selectWorkspaceSession(
  runtime: WorkspaceHistoryRuntime,
  owner: string,
  input: z.infer<typeof WorkspaceSessionSelect>
) {
  const history = await loadWorkspaceSessionHistory(runtime, owner, { worktree: input.worktree })
  const item = history.items.find((item) => item.row.key === input.key)
  if (!item) {
    throw new Error('Session is unavailable or does not belong to this workspace.')
  }
  return { ...history, item }
}

export async function readWorkspaceSession(
  item: Awaited<ReturnType<typeof selectWorkspaceSession>>['item'],
  before?: number
) {
  const session = item.native
  if (!session) {
    throw new Error('Open this Workflow record through its node conversation.')
  }
  const transcript = await readNativeChatTranscriptTail({
    agent: session.agent,
    sessionId: session.sessionId,
    transcriptPath: session.filePath,
    limit: 50,
    beforeOffset: before
  })
  let entries: WorkflowSessionEntry[] = []
  let limited = false
  if ('messages' in transcript) {
    entries = transcript.messages.flatMap(publicMessage)
    limited = entries.some((entry) => entry.limited === true)
  } else {
    limited = true
    entries = session.previewMessages.slice(-50).map((message, index) => ({
      id: String(index),
      role: message.role === 'unknown' ? 'system' : message.role,
      text: redactString(message.text).slice(0, 16_000)
    }))
  }
  let budget = 16_000
  while (Buffer.byteLength(JSON.stringify(entries)) > 280_000) {
    limited = true
    budget = Math.floor(budget / 2)
    entries = entries.map((entry) => boundSessionRecordEntry(entry, budget))
  }
  return {
    row: item.row,
    entries,
    limited,
    before: 'messages' in transcript ? transcript.beforeOffset : 0,
    hasMore: 'messages' in transcript ? transcript.hasMore : false
  }
}
