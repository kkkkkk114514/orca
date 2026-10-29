import { describe, expect, it } from 'vitest'
import { WorkflowOutputActivity } from './workflow-output-activity'

describe('workflow activity projection', () => {
  it('decodes split UTF-8 tool output and excludes reasoning and credentials', () => {
    const activity = new WorkflowOutputActivity('ctx_activity')
    const bytes = Buffer.from(
      [
        JSON.stringify({ type: 'thinking', text: 'private reasoning' }),
        JSON.stringify({ type: 'tool_call', tool: 'shell', input: { command: 'npm test' } }),
        JSON.stringify({
          type: 'tool_result',
          status: 'completed',
          result: '检查通过\nAPI_KEY=secret-value'
        }),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'reasoning', text: 'more reasoning' }
        })
      ].join('\n')
    )
    for (const byte of bytes) {
      activity.stdout(Buffer.from([byte]))
    }
    activity.finish(true)
    const log = activity.value.entries.map((entry) => entry.text).join('\n')
    expect(log).toContain('npm test')
    expect(log).toContain('检查通过')
    expect(log).not.toContain('secret-value')
    expect(log).not.toContain('reasoning')
    expect(activity.value.state).toBe('finished')
  })

  it('bounds long output and recovers after oversized or unknown protocol records', () => {
    const activity = new WorkflowOutputActivity('ctx_activity')
    activity.stdout('x'.repeat(2 * 1024 * 1024))
    activity.stdout('\n')
    for (let index = 0; index < 40; index++) {
      activity.stdout(
        `${JSON.stringify({ type: 'text', text: `message ${index} ${'x'.repeat(2000)}` })}\n`
      )
    }
    activity.finish(false)
    expect(activity.value.entries).toHaveLength(30)
    expect(new Set(activity.value.entries.map((entry) => entry.id)).size).toBe(30)
    expect(activity.value.entries.every((entry) => entry.text.length <= 800)).toBe(true)
    expect(activity.value.entries.at(-2)?.text).toContain('message 39')
    expect(activity.value.omitted).toBeGreaterThan(0)
    expect(activity.value.state).toBe('interrupted')
  })
})
