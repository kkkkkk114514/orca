import { describe, expect, it } from 'vitest'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { workflowReportPaths, workflowRunPaths } from './workflow-report-paths'

const root = join(tmpdir(), 'workflow-report-path-contract')
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('workflow report locations', () => {
  it('namespaces owners and retains portable node and dispatch directories', () => {
    const first = workflowRunPaths(root, 'desktop', id)
    const other = workflowRunPaths(root, 'another-device', id)
    expect(first.directory).not.toBe(other.directory)
    expect(relative(root, first.directory).split(/[\\/]/)).toHaveLength(2)
    expect(first.metadata).toBe(join(first.directory, 'run.json'))
    expect(first.checkpoint).toBe(join(first.directory, 'execution.json'))
    expect(workflowReportPaths(first.directory, 'develop', 'ctx_first').report).toBe(
      join(first.directory, 'reports', 'develop', 'dispatch-ctx_first', 'report.json')
    )
    expect(workflowReportPaths(first.directory, 'CON', 'ctx_first').artifacts).toBe(
      join(first.directory, 'reports', '~434f4e', 'dispatch-ctx_first', 'artifacts')
    )
    expect(
      workflowReportPaths(first.directory, 'Develop', 'ctx_first').directory.toLowerCase()
    ).not.toBe(workflowReportPaths(first.directory, 'develop', 'ctx_first').directory.toLowerCase())
    expect(workflowReportPaths(first.directory, 'con', 'ctx_first').artifacts).toContain('_con')
  })

  it('rejects relative roots and traversal in IDs before preparing any files', () => {
    expect(() => workflowRunPaths(root, 'desktop', '../other-run')).toThrow()
    for (const node of ['../other', 'a/b', 'a\\b', '.', 'a:b']) {
      expect(() => workflowReportPaths(root, node, 'ctx_valid')).toThrow()
    }
    for (const dispatch of ['../other', 'a/b', 'a\\b', '.', 'a:b']) {
      expect(() => workflowReportPaths(root, 'develop', dispatch)).toThrow()
    }
    expect(() => workflowReportPaths('relative-root', 'develop', 'ctx_valid')).toThrow()
  })
})
