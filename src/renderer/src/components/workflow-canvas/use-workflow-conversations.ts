import { useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  workflowConversationOptionsSchema,
  type WorkflowConversationOption
} from '../../../../shared/workflow-node-conversation'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { WorkflowExecutionTarget } from './WorkflowRunPanel'

export function useWorkflowConversations(agent: TuiAgent, target: WorkflowExecutionTarget | null) {
  const [rows, setRows] = useState<WorkflowConversationOption[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    setRows([])
    setLoaded(false)
    setError('')
    if (!target) {
      return
    }
    const controller = new AbortController()
    void callRuntimeRpc<unknown>(
      target.target,
      'workflow.conversations',
      { worktree: `id:${target.worktreeId}`, agent, force: revision > 0 },
      { signal: controller.signal }
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setRows(workflowConversationOptionsSchema.parse(result).rows)
          setLoaded(true)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError(
            translate(
              'workflows.conversationsError',
              'Cannot load conversations. Check the workspace and execution host version, or choose New conversation.'
            )
          )
        }
      })
    return () => controller.abort()
  }, [agent, target, revision])
  return {
    rows,
    loaded,
    error,
    busy: Boolean(target && !loaded && !error),
    refresh: () => setRevision((current) => current + 1)
  }
}
