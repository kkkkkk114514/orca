import { expect, it } from 'vitest'
import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../../shared/mobile-bridge-frame-bytes'
import type { WorkflowSessionPage } from '../../../shared/workflow-session-view'
import { boundWorkflowSessionPage } from './workflow-session-page-bounds'

it('bounds multilingual and escaped output for remote/mobile without skipping records or advancing cursors', () => {
  const text = '开发记录\u0001'.repeat(3000)
  const page: WorkflowSessionPage = {
    id: '00000000-0000-4000-8000-000000000001',
    nodeId: 'develop',
    workspaceId: 'folder:project',
    agent: 'dsh',
    dispatchId: 'ctx_actual',
    visits: [{ dispatchId: 'ctx_actual', outcome: 'running' }],
    source: 'journal',
    before: 12345,
    hasMore: true,
    limited: false,
    entries: Array.from({ length: 50 }, (_, index) => ({
      id: String(index),
      role: 'activity',
      text,
      blocks: [{ type: 'tool-result', output: text.repeat(4) }]
    })),
    task: text,
    instructions: text,
    report: text
  }
  const bounded = boundWorkflowSessionPage(page)
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(
    MOBILE_BRIDGE_MAX_FRAME_BYTES / 2
  )
  expect(bounded.limited).toBe(true)
  expect(bounded.before).toBe(12345)
  expect(bounded.hasMore).toBe(true)
  expect(bounded.entries.map((entry) => entry.id)).toEqual(page.entries.map((entry) => entry.id))
  expect(page.limited).toBe(false)
  expect(page.entries[0]?.text).toBe(text)
  expect(bounded.entries[0]?.blocks).toMatchObject([{ type: 'tool-result' }])
  expect(page.entries[0]?.blocks).toBeDefined()
})
