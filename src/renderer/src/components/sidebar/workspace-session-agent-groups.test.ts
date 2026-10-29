import { expect, it } from 'vitest'
import type { WorkspaceSessionRow } from '../../../../shared/workspace-session-history'
import {
  groupWorkspaceSessionHistory,
  workspaceSessionDisplayTitle
} from './workspace-session-agent-groups'

function session(
  agent: WorkspaceSessionRow['agent'],
  updatedAt: number,
  key: string
): WorkspaceSessionRow {
  return { agent, updatedAt, key, title: `Task ${key}`, archived: false, source: 'cli' }
}

it('groups each Agent independently and sorts its conversations newest first without mutating input', () => {
  const rows = [
    session('dsh', 10, 'first'),
    session('codex', 20, 'other'),
    session('dsh', 40, 'latest')
  ]
  const copy = rows.map((row) => ({ ...row }))
  const groups = groupWorkspaceSessionHistory(rows)
  expect(groups.map((group) => group.agent)).toEqual(['codex', 'dsh'])
  expect(groups.find((group) => group.agent === 'dsh')?.sessions.map((row) => row.key)).toEqual([
    'latest',
    'first'
  ])
  expect(rows).toEqual(copy)
})

it('filters loaded conversations while retaining their Agent groups and date order', () => {
  const rows = [session('dsh', 10, 'one'), session('codex', 20, 'two'), session('dsh', 30, 'three')]
  expect(groupWorkspaceSessionHistory(rows, ' DSH ')[0]?.sessions.map((row) => row.key)).toEqual([
    'three',
    'one'
  ])
  expect(groupWorkspaceSessionHistory(rows, 'Task two').map((group) => group.agent)).toEqual([
    'codex'
  ])
  expect(groupWorkspaceSessionHistory(rows, 'missing')).toEqual([])
})

it('shows task titles in grouped Workflow rows without generated node identifiers', () => {
  const row = {
    ...session('codex', 1, 'task'),
    title: 'node_abc · Plan the game',
    workflow: { id: 'run', nodeId: 'node_abc' }
  }
  expect(workspaceSessionDisplayTitle(row)).toBe('Plan the game')
  expect(workspaceSessionDisplayTitle(session('codex', 1, 'normal'))).toBe('Task normal')
})
