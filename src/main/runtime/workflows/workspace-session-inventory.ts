import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AiVaultSession } from '../../../shared/ai-vault-types'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { WorkspaceSessionRow } from '../../../shared/workspace-session-history'
import { readWorkflowCheckpoint } from '../../../shared/node-workflow-checkpoint'
import { readWorkflowMetadata } from './workflow-run-metadata'
import { workflowRunPaths } from './workflow-report-paths'
import type { WorkflowHeadlessReceipts } from './workflow-headless-receipts'

export type WorkspaceHistoryItem = { row: WorkspaceSessionRow; native?: AiVaultSession }
const key = (parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

export async function workspaceSessionInventory(args: {
  root: string
  owner: string
  workspace: { id: string; path: string }
  native: AiVaultSession[]
  receipts: WorkflowHeadlessReceipts
}) {
  const items: WorkspaceHistoryItem[] = []
  const covered = new Set<string>()
  const busySessions = new Set<string>()
  const issues: string[] = []
  const directory = dirname(
    workflowRunPaths(args.root, args.owner, '00000000-0000-4000-8000-000000000000').directory
  )
  let runs: string[] = []
  try {
    runs = await readdir(directory)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }
  if (runs.length > 5000) {
    issues.push('Workflow history scan is limited to 5,000 runs.')
  }
  for (const id of runs.slice(0, 5000)) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) {
      continue
    }
    try {
      const paths = workflowRunPaths(args.root, args.owner, id)
      const metadata = await readWorkflowMetadata(paths)
      if (metadata.request.id !== id) {
        throw new Error('Workflow run identity mismatch')
      }
      if (metadata.request.worktree !== `id:${args.workspace.id}`) {
        continue
      }
      const execution = await readWorkflowCheckpoint(paths.checkpoint)
      if (
        execution.context.target !== args.owner ||
        execution.context.from !== metadata.coordinator ||
        execution.context.worktree !== metadata.request.worktree
      ) {
        throw new Error('Workflow identity mismatch')
      }
      const modified = (await stat(paths.checkpoint)).mtimeMs
      for (const node of execution.definition.nodes) {
        if (node.type !== 'agent') {
          continue
        }
        const steps = execution.steps.filter((step) => step.nodeId === node.id && step.dispatchId)
        if (!steps.length) {
          continue
        }
        items.push({
          row: {
            key: key(['workflow', id, node.id]),
            agent: node.agent,
            title: `${node.id} · ${execution.input.split('\n')[0]}`.slice(0, 500),
            updatedAt: modified,
            source: 'workflow',
            archived: false,
            running:
              execution.status === 'running' &&
              !metadata.paused &&
              !metadata.error &&
              steps.some(
                (step) =>
                  !step.report &&
                  !step.released &&
                  step.dispatchId === execution.steps.at(-1)?.dispatchId
              ),
            workflow: { id, nodeId: node.id }
          }
        })
        for (const step of steps) {
          if (!step.dispatchId) {
            continue
          }
          const chosen = metadata.conversations?.[node.id]
          if (
            !step.released &&
            chosen?.agent === node.agent &&
            chosen.workspaceId === args.workspace.id
          ) {
            busySessions.add(`${chosen.agent}:${chosen.sessionId}`)
          }
          try {
            const saved = await args.receipts.read(step.dispatchId)
            if (
              saved.sessionId &&
              saved.dispatchId === step.dispatchId &&
              saved.taskId === step.taskId &&
              saved.coordinator === execution.context.from &&
              saved.binding &&
              saved.binding.runId === execution.runId &&
              saved.binding.workspaceId === args.workspace.id &&
              saved.binding.nodeId === node.id &&
              saved.binding.agent === node.agent
            ) {
              covered.add(`${node.agent}:${saved.sessionId}`)
              if (!step.released) {
                busySessions.add(`${node.agent}:${saved.sessionId}`)
              }
            }
          } catch {
            /* Older workers may not have a headless receipt. */
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        continue
      }
      if (issues.length < 9) {
        issues.push(`Cannot read workflow history ${id}.`)
      }
    }
  }
  const workspace = normalizeRuntimePathForComparison(args.workspace.path)
  const seen = new Set<string>()
  for (const session of args.native) {
    if (
      ![session.cwd, ...(session.cwdAliases ?? [])].some(
        (cwd) => cwd && normalizeRuntimePathForComparison(cwd) === workspace
      ) ||
      covered.has(`${session.agent}:${session.sessionId}`)
    ) {
      continue
    }
    const identity = key(['cli', session.agent, session.sessionId, session.filePath])
    if (seen.has(identity)) {
      continue
    }
    seen.add(identity)
    const updated = Date.parse(session.updatedAt ?? session.modifiedAt)
    items.push({
      native: session,
      row: {
        key: identity,
        agent: session.agent,
        title: session.title.slice(0, 500) || session.sessionId,
        updatedAt: Number.isFinite(updated) ? updated : 0,
        archived: false,
        source: 'cli'
      }
    })
  }
  return {
    items: items.sort(
      (a, b) => b.row.updatedAt - a.row.updatedAt || a.row.key.localeCompare(b.row.key)
    ),
    issues,
    busySessions
  }
}
