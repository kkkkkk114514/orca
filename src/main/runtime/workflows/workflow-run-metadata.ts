import { readFile } from 'node:fs/promises'
import { writeDurableSecureJsonFile } from '../../../shared/secure-file'
import { z } from 'zod'
import { workflowRunStartSchema } from '../../../shared/workflow-run-contract'
import { workflowNodeConversationsSchema } from '../../../shared/workflow-node-conversation'
import type { WorkflowNodeConversations } from '../../../shared/workflow-node-conversation'
import type { WorkflowRunStart } from '../../../shared/workflow-run-contract'

const storedRequest = workflowRunStartSchema
  .extend({ continueFrom: z.unknown().optional() })
  .transform(({ continueFrom: _legacy, ...request }) => request)

export const metadataSchema = z.object({
  request: storedRequest,
  createdAt: z.number(),
  conversations: workflowNodeConversationsSchema.optional(),
  coordinator: z.string().optional(),
  paused: z.boolean(),
  interruption: z
    .object({
      nodeId: z.string(),
      dispatchId: z.string(),
      messages: z.array(z.object({ id: z.string().uuid(), text: z.string().max(16_000) })).max(100)
    })
    .optional(),
  waiting: z.string().optional(),
  error: z.string().optional()
})
export type Metadata = z.infer<typeof metadataSchema>

export function isMissingWorkflowFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export function saveWorkflowMetadata(paths: { metadata: string }, metadata: Metadata) {
  writeDurableSecureJsonFile(paths.metadata, metadata)
}
export async function readWorkflowMetadata(paths: { metadata: string }) {
  return metadataSchema.parse(JSON.parse(await readFile(paths.metadata, 'utf8')))
}

export async function loadOrCreateWorkflowMetadata(
  paths: { metadata: string },
  request: WorkflowRunStart,
  resolveConversations: () => Promise<WorkflowNodeConversations>
): Promise<Metadata> {
  try {
    const metadata = await readWorkflowMetadata(paths)
    if (JSON.stringify(metadata.request) !== JSON.stringify(request)) {
      throw new Error('Workflow request ID was already used with different input')
    }
    return metadata
  } catch (error) {
    if (!isMissingWorkflowFile(error)) {
      throw error
    }
    const metadata = {
      request,
      createdAt: Date.now(),
      paused: false,
      conversations: await resolveConversations()
    }
    saveWorkflowMetadata(paths, metadata)
    return metadata
  }
}
