import type { WorkspaceSessionRow } from '../../../../shared/workspace-session-history'

export function groupWorkspaceSessionHistory(rows: readonly WorkspaceSessionRow[], query = '') {
  const groups = new Map<WorkspaceSessionRow['agent'], WorkspaceSessionRow[]>()
  const filter = query.trim().toLocaleLowerCase()
  for (const row of rows) {
    if (filter && !`${row.title} ${row.agent}`.toLocaleLowerCase().includes(filter)) {
      continue
    }
    const group = groups.get(row.agent) ?? []
    group.push(row)
    groups.set(row.agent, group)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agent, sessions]) => ({
      agent,
      sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key))
    }))
}

export function workspaceSessionDisplayTitle(row: WorkspaceSessionRow) {
  const prefix = row.workflow ? `${row.workflow.nodeId} · ` : ''
  return prefix && row.title.startsWith(prefix) ? row.title.slice(prefix.length) : row.title
}
