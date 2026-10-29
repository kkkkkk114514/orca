import { expect, it } from 'vitest'
import { workflowRunStartSchema } from '../../../shared/workflow-run-contract'
import { metadataSchema } from './workflow-run-metadata'

it('rejects obsolete whole-run continuation while preserving readable legacy metadata', () => {
  const request = {
    id: '01800000-0000-4000-8000-000000000001',
    worktree: 'id:folder:example',
    input: 'Task',
    definition: {
      version: 1,
      name: 'Example',
      entry: 'done',
      maxSteps: 1,
      nodes: [{ id: 'done', type: 'end', outcome: 'succeeded' }]
    }
  }
  const legacy = { ...request, continueFrom: '01800000-0000-4000-8000-000000000002' }
  expect(workflowRunStartSchema.safeParse(legacy).success).toBe(false)
  const metadata = metadataSchema.parse({
    request: legacy,
    sessionRootId: legacy.continueFrom,
    createdAt: 1,
    paused: false
  })
  expect(metadata.request).toEqual(workflowRunStartSchema.parse(request))
  expect(metadata).not.toHaveProperty('sessionRootId')
})
