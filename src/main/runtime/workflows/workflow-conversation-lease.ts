import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { check, lock } from 'proper-lockfile'
import type { WorkflowResolvedConversation } from '../../../shared/workflow-node-conversation'

function leasePath(
  root: string,
  conversation: Pick<WorkflowResolvedConversation, 'agent' | 'sessionId'>
) {
  const key = createHash('sha256')
    .update(JSON.stringify([conversation.agent, conversation.sessionId]))
    .digest('hex')
  return join(root, 'conversation-leases', key)
}

export async function isWorkflowConversationBusy(
  root: string,
  conversation: Pick<WorkflowResolvedConversation, 'agent' | 'sessionId'>
) {
  return check(leasePath(root, conversation), { realpath: false })
}

export async function claimWorkflowConversation(
  root: string,
  conversation: Pick<WorkflowResolvedConversation, 'agent' | 'sessionId'>
) {
  const path = leasePath(root, conversation)
  await mkdir(join(root, 'conversation-leases'), { recursive: true, mode: 0o700 })
  await writeFile(path, '', { flag: 'a', mode: 0o600 })
  try {
    const release = await lock(path, { realpath: false, retries: 0 })
    let held = true
    return async () => {
      if (held) {
        held = false
        await release()
      }
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ELOCKED') {
      throw new Error(
        'Selected conversation is already in use. Wait for it to finish or choose a new conversation.'
      )
    }
    throw error
  }
}
