import { withWorkflowCheckpoint as withNodeWorkflowCheckpoint } from '../shared/node-workflow-checkpoint'
import { RuntimeClientError } from './runtime/types'
export { readWorkflowCheckpoint } from '../shared/node-workflow-checkpoint'

export const withWorkflowCheckpoint: typeof withNodeWorkflowCheckpoint = async (
  path,
  create,
  operation
) => {
  try {
    return await withNodeWorkflowCheckpoint(path, create, operation)
  } catch (error) {
    if (error instanceof RuntimeClientError) {
      throw error
    }
    throw new RuntimeClientError(
      'workflow_checkpoint_error',
      `Workflow checkpoint could not be used: ${path}. ${error instanceof Error ? error.message : 'Unknown error'}`
    )
  }
}
