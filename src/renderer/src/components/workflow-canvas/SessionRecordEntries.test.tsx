// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SessionRecordEntries } from './SessionRecordEntries'
import { openToolRunMembers } from '../native-chat/native-chat-tool-run-members-test-support'
import type { WorkflowSessionEntry } from '../../../../shared/workflow-session-view'

vi.mock('../native-chat/use-native-chat-store-appearance-style', () => ({
  useNativeChatStoreAppearanceStyle: () => ({})
}))
afterEach(cleanup)

it('reuses native folded tool activity and expands commands, outputs and file diffs without a composer', () => {
  const entries: WorkflowSessionEntry[] = [
    { id: 'user', role: 'user', text: 'Implement the task' },
    {
      id: 'assistant',
      role: 'assistant',
      text: 'Done',
      blocks: [{ type: 'text', text: '**Done**' }]
    },
    {
      id: 'call',
      role: 'assistant',
      text: 'npm test',
      blocks: [
        {
          type: 'tool-call',
          name: 'shell',
          callId: 'cmd',
          state: 'completed',
          input: { command: 'npm test' }
        }
      ]
    },
    {
      id: 'result',
      role: 'tool',
      text: 'All tests passed',
      blocks: [{ type: 'tool-result', callId: 'cmd', output: 'All tests passed' }]
    },
    {
      id: 'write',
      role: 'assistant',
      text: 'Created demo.ts',
      blocks: [
        {
          type: 'tool-call',
          name: 'Write',
          state: 'completed',
          input: { path: 'demo.ts', content: 'export const demo = 1' }
        }
      ]
    }
  ]
  const view = render(<SessionRecordEntries entries={entries} />)
  expect(screen.getByText('Done').tagName).toBe('STRONG')
  expect(screen.queryByText('All tests passed')).toBeNull()
  expect(screen.queryByText('export const demo = 1')).toBeNull()
  const header = view.container.querySelector('button[aria-expanded="false"]')
  if (!(header instanceof HTMLElement)) {
    throw new Error('Missing native tool summary')
  }
  fireEvent.click(header)
  openToolRunMembers()
  expect(view.container).toHaveTextContent('npm test')
  expect(view.container).toHaveTextContent('All tests passed')
  expect(view.container).toHaveTextContent('export const demo = 1')
  expect(view.container.querySelector('[data-native-chat-tool-run-members]')).not.toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  view.rerender(
    <SessionRecordEntries
      entries={[...entries, { id: 'legacy', role: 'activity', text: 'Legacy output retained' }]}
    />
  )
  expect(view.container).toHaveTextContent('Legacy output retained')
  expect(view.container).toHaveTextContent('All tests passed')
})
