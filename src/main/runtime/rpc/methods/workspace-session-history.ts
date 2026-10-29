import { defineMethod } from '../core'
import { workflowCallerOwner } from './workflow-runs'
import {
  WorkspaceSessionArchive,
  WorkspaceSessionRead,
  WorkspaceSessionsList
} from '../../../../shared/workspace-session-history'
import {
  loadWorkspaceSessionHistory,
  readWorkspaceSession,
  selectWorkspaceSession
} from '../../workflows/workspace-session-history'

export const WORKSPACE_SESSION_HISTORY_METHODS = [
  defineMethod({
    name: 'workspaceSessions.list',
    permission: 'workspace',
    params: WorkspaceSessionsList,
    async handler(params, context) {
      const history = await loadWorkspaceSessionHistory(
        context.runtime,
        workflowCallerOwner(context),
        params
      )
      const rows = history.items
        .map((item) => item.row)
        .filter((row) => row.archived === Boolean(params.archived))
      const offset = params.offset ?? 0
      return {
        rows: rows.slice(offset, offset + 50),
        total: rows.length,
        hasMore: offset + 50 < rows.length,
        issues: history.issues
      }
    }
  }),
  defineMethod({
    name: 'workspaceSessions.archive',
    permission: 'workspace',
    params: WorkspaceSessionArchive,
    async handler(params, context) {
      const owner = workflowCallerOwner(context)
      const { archive, workspace, item } = await selectWorkspaceSession(
        context.runtime,
        owner,
        params
      )
      await archive.set(owner, workspace.id, item.row.key, params.archived)
      return { key: item.row.key, archived: params.archived }
    }
  }),
  defineMethod({
    name: 'workspaceSessions.read',
    permission: 'workspace',
    params: WorkspaceSessionRead,
    async handler(params, context) {
      const { item } = await selectWorkspaceSession(
        context.runtime,
        workflowCallerOwner(context),
        params
      )
      return readWorkspaceSession(item, params.before)
    }
  })
]
