import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { workflowRunIdSchema } from '../../../shared/workflow-run-contract'

export function workflowRunPaths(root: string, owner: string, id: string) {
  workflowRunIdSchema.parse({ id })
  const directory = join(root, createHash('sha256').update(owner).digest('hex'), id)
  return {
    directory,
    metadata: join(directory, 'run.json'),
    checkpoint: join(directory, 'execution.json')
  }
}

export function workflowReportPaths(root: string, nodeId: string, dispatchId: string) {
  if (!isAbsolute(root) || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(nodeId)) {
    throw new Error('Invalid workflow report location.')
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,239}$/.test(dispatchId)) {
    throw new Error('Invalid workflow report dispatch identity.')
  }
  const portableNode = /[A-Z]/.test(nodeId)
    ? `~${Buffer.from(nodeId).toString('hex')}`
    : /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(nodeId)
      ? `_${nodeId}`
      : nodeId
  const directory = join(root, 'reports', portableNode, `dispatch-${dispatchId}`)
  return {
    directory,
    report: join(directory, 'report.json'),
    markdown: join(directory, 'report.md'),
    artifacts: join(directory, 'artifacts')
  }
}

export async function prepareWorkflowReportArtifacts(
  root: string | undefined,
  nodeId: string | undefined,
  dispatchId: string
): Promise<string | undefined> {
  if (!root || !nodeId) {
    return undefined
  }
  const { artifacts } = workflowReportPaths(root, nodeId, dispatchId)
  await mkdir(artifacts, { recursive: true, mode: 0o700 })
  return artifacts
}
