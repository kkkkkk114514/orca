import { expect, it } from 'vitest'
import { publicMessage } from './public-session-message'
import { workflowSessionEntrySchema } from '../../../shared/workflow-session-view'

it('keeps public commands, matching outputs and edits as structured blocks with secrets redacted', () => {
  const entries = publicMessage({
    id: 'answer',
    role: 'assistant',
    timestamp: 1234,
    source: 'transcript',
    blocks: [
      { type: 'text', text: '**Verified**' },
      {
        type: 'tool-call',
        name: 'shell',
        callId: 'call-1',
        input: { command: 'npm test', api_key: 'private-key' }
      },
      { type: 'tool-result', callId: 'call-1', output: 'passed\nAPI_KEY=private-value' },
      {
        type: 'tool-call',
        name: 'Write',
        input: { path: 'index.ts', content: 'export const ready = true' }
      }
    ]
  })
  expect(entries[0]).toMatchObject({
    at: 1234,
    blocks: [
      { type: 'text', text: '**Verified**' },
      { type: 'tool-call', callId: 'call-1', input: { command: 'npm test' } },
      { type: 'tool-result', callId: 'call-1' },
      {
        type: 'tool-call',
        name: 'Write',
        input: { path: 'index.ts', content: 'export const ready = true' }
      }
    ]
  })
  expect(JSON.stringify(entries)).not.toMatch(/private-key|private-value/)
  expect(workflowSessionEntrySchema.parse(entries[0])).toEqual(entries[0])
  expect(
    publicMessage({
      id: 'thought',
      role: 'reasoning',
      timestamp: null,
      source: 'transcript',
      blocks: [{ type: 'text', text: 'private thought' }]
    })
  ).toEqual([])
})

it('bounds oversized content without turning tool cards into plain text and accepts old records', () => {
  const entry = publicMessage({
    id: 'large',
    role: 'tool',
    timestamp: null,
    source: 'transcript',
    blocks: [{ type: 'tool-result', output: '开发'.repeat(40_000) }]
  })[0]
  expect(entry?.blocks).toMatchObject([
    { type: 'tool-result', output: expect.stringContaining('开发') }
  ])
  expect(entry?.limited).toBe(true)
  expect(entry?.text.length).toBeLessThanOrEqual(16_000)
  expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThanOrEqual(64_000)
  expect(
    workflowSessionEntrySchema.parse({ id: 'old', role: 'activity', text: 'Old output' }).text
  ).toBe('Old output')
  expect(
    workflowSessionEntrySchema.parse({
      id: 'future',
      role: 'assistant',
      text: 'Fallback',
      blocks: [{ type: 'future-block' }]
    }).blocks
  ).toBeUndefined()
})

it('retains tool identity, failure state and pairing while limiting oversized arguments', () => {
  const entry = publicMessage({
    id: 'large-call',
    role: 'assistant',
    timestamp: null,
    source: 'transcript',
    blocks: [
      {
        type: 'tool-call',
        name: 'exec',
        callId: 'matched-call',
        state: 'failed',
        input: { command: 'x'.repeat(100_000), api_key: 'hidden-secret' }
      },
      { type: 'tool-result', callId: 'matched-call', isError: true, output: 'y'.repeat(100_000) }
    ]
  })[0]
  expect(entry.blocks).toMatchObject([
    { type: 'tool-call', name: 'exec', callId: 'matched-call', state: 'failed' },
    { type: 'tool-result', callId: 'matched-call', isError: true }
  ])
  expect(JSON.stringify(entry)).not.toContain('hidden-secret')
  expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThanOrEqual(64_000)
  expect(entry.limited).toBe(true)
})

it('preserves complete tool details when the record already fits the read budget', () => {
  const output = 'verified output '.repeat(2000)
  const entry = publicMessage({
    id: 'within-budget',
    role: 'tool',
    timestamp: null,
    source: 'transcript',
    blocks: [{ type: 'tool-result', callId: 'call-fit', output }]
  })[0]
  expect(entry.blocks).toEqual([{ type: 'tool-result', callId: 'call-fit', output }])
  expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThanOrEqual(64_000)
})

it('decodes serialized arguments and raw patches and retains empty failed tool results', () => {
  const blocks = publicMessage({
    id: 'encoded',
    role: 'assistant',
    timestamp: null,
    source: 'transcript',
    blocks: [
      {
        type: 'tool-call',
        name: 'shell',
        input: JSON.stringify({ command: 'npm test', api_key: 'private-key' })
      },
      {
        type: 'tool-call',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** Add File: demo.ts\n+export const demo = 1\n*** End Patch'
      }
    ]
  })[0]?.blocks
  expect(blocks).toMatchObject([
    { type: 'tool-call', input: { command: 'npm test' } },
    { type: 'tool-call', input: { patch: expect.stringContaining('*** Add File: demo.ts') } }
  ])
  expect(JSON.stringify(blocks)).not.toContain('private-key')
  expect(
    publicMessage({
      id: 'error',
      role: 'tool',
      timestamp: null,
      source: 'transcript',
      blocks: [{ type: 'tool-result', output: '', isError: true }]
    })[0]?.blocks
  ).toEqual([{ type: 'tool-result', output: '', isError: true }])
})
