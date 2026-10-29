import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { WorkflowExecution } from '../../../shared/workflow-execution'
import type { WorkflowStorageRequest } from '../../../shared/workflow-run-storage'
import { writeDurableSecureJsonFile } from '../../../shared/secure-file'
import { WorkflowHeadlessReceipts } from './workflow-headless-receipts'
import { readWorkflowCheckpoint } from '../../../shared/node-workflow-checkpoint'
import { lock } from 'proper-lockfile'
import { workflowStorageRequestSchema } from '../../../shared/workflow-run-storage'
import { workflowRunPaths, workflowReportPaths } from './workflow-report-paths'

type File = { path: string; root: string; bytes: number; modified: number }

async function inspect(root: string, path: string) {
  const suffix = relative(resolve(root), resolve(path))
  if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) {
    throw new Error('Invalid cleanup boundary')
  }
  let cursor = resolve(path)
  let file
  while (true) {
    let entry
    try {
      entry = await lstat(cursor)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined
      }
      throw error
    }
    if (entry.isSymbolicLink()) {
      throw new Error('Cleanup refuses symbolic links or directory junctions')
    }
    if (cursor === resolve(path)) {
      file = entry
    }
    if (cursor === resolve(root)) {
      break
    }
    cursor = dirname(cursor)
  }
  return file
}

export async function workflowStoragePlan(
  runRoot: string,
  headlessRoot: string | undefined,
  execution: WorkflowExecution,
  request: WorkflowStorageRequest
) {
  const files: File[] = []
  const markers: string[] = []
  const add = async (root: string, path: string) => {
    if (files.length >= 10_000) {
      throw new Error('Cleanup preview exceeds 10,000 files; narrow its scope')
    }
    const stat = await inspect(root, path)
    if (!stat) {
      return
    }
    if (!stat.isFile()) {
      throw new Error('Cleanup target is not a regular file')
    }
    files.push({ root, path, bytes: stat.size, modified: stat.mtimeMs })
  }
  const visit = async (path: string) => {
    const stat = await inspect(runRoot, path)
    if (!stat) {
      return
    }
    if (!stat.isDirectory()) {
      throw new Error('Invalid artifacts directory')
    }
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      await (entry.isDirectory() ? visit(child) : add(runRoot, child))
    }
  }
  for (const step of execution.steps) {
    if (!step.dispatchId) {
      continue
    }
    if (request.category !== 'logs') {
      await visit(workflowReportPaths(runRoot, step.nodeId, step.dispatchId).artifacts)
    }
    if (headlessRoot && request.category !== 'artifacts') {
      const receipts = new WorkflowHeadlessReceipts(headlessRoot)
      const receiptPath = receipts.path(step.dispatchId)
      if (!(await inspect(headlessRoot, receiptPath))) {
        continue
      }
      const saved = await receipts.read(step.dispatchId)
      if (
        !saved.binding ||
        saved.binding.runId !== execution.runId ||
        saved.binding.nodeId !== step.nodeId ||
        `id:${saved.binding.workspaceId}` !== execution.context.worktree ||
        saved.coordinator !== execution.context.from ||
        saved.taskId !== step.taskId ||
        saved.dispatchId !== step.dispatchId
      ) {
        throw new Error('Cleanup receipt ownership mismatch')
      }
      markers.push(`${receiptPath}.conversation.deleted`)
      for (const suffix of [
        '.conversation.jsonl',
        '.conversation.jsonl.limited',
        '.activity.json'
      ]) {
        await add(headlessRoot, receiptPath + suffix)
      }
    }
  }
  const confirmation = createHash('sha256')
    .update(JSON.stringify({ id: request.id, category: request.category, files, markers }))
    .digest('hex')
  return {
    files,
    markers,
    headlessRoot,
    preview: {
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      canClear: execution.status !== 'running' && execution.steps.every((step) => step.released),
      confirmation
    }
  }
}

export async function clearWorkflowStorage(
  plan: Awaited<ReturnType<typeof workflowStoragePlan>>,
  confirmation: string
) {
  if (!plan.preview.canClear) {
    throw new Error('Running or recoverable workflows cannot be cleared')
  }
  if (confirmation !== plan.preview.confirmation) {
    throw new Error('Storage changed; preview cleanup again')
  }
  for (const marker of plan.markers) {
    if (!plan.headlessRoot) {
      throw new Error('Missing journal root')
    }
    await inspect(plan.headlessRoot, marker)
    writeDurableSecureJsonFile(marker, { clearedAt: Date.now() })
  }
  let deleted = 0
  const errors: string[] = []
  let errorCount = 0
  for (const file of plan.files) {
    try {
      const stat = await inspect(file.root, file.path)
      if (!stat) {
        continue
      }
      if (stat.size !== file.bytes || stat.mtimeMs !== file.modified) {
        throw new Error('File changed after preview')
      }
      await unlink(file.path)
      deleted++
    } catch (error) {
      errorCount++
      if (errors.length < 20) {
        errors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return { ...plan.preview, deleted, errors, errorCount }
}

export async function workflowJournalCleared(receiptPath: string) {
  try {
    await readFile(`${receiptPath}.conversation.deleted`)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

export async function manageWorkflowStorage(
  root: string,
  headlessRoot: string | undefined,
  owner: string,
  raw: WorkflowStorageRequest,
  active: boolean
) {
  const input = workflowStorageRequestSchema.parse(raw)
  const paths = workflowRunPaths(root, owner, input.id)
  await readFile(paths.metadata, 'utf8')
  const release = await lock(paths.directory, { realpath: false, retries: 0 })
  try {
    const execution = await readWorkflowCheckpoint(paths.checkpoint)
    if (execution.context.target !== owner) {
      throw new Error('Workflow owner mismatch')
    }
    const plan = await workflowStoragePlan(paths.directory, headlessRoot, execution, input)
    if (input.confirmation) {
      if (active) {
        throw new Error('Workflow observer is still active')
      }
      return await clearWorkflowStorage(plan, input.confirmation)
    }
    return plan.preview
  } finally {
    await release()
  }
}
