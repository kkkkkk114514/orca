import { describe, expect, it } from 'vitest'
import { WorkflowHeadlessProtocol } from './workflow-headless-protocol'
import { WorkflowOutputActivity } from './workflow-output-activity'
import { readWorkflowHeadlessReport } from './workflow-headless-command'

describe('streamed workflow completion metadata', () => {
  it('extracts only the ZCode final result from a live event stream', () => {
    const protocol = new WorkflowHeadlessProtocol('zcode')
    const activity = new WorkflowOutputActivity('ctx_zcode', (value, line) =>
      protocol.accept(value, line)
    )
    const report = { outcome: 'succeeded', body: 'resumed and verified', filesModified: [] }
    const result = {
      type: 'result',
      sessionId: 'sess_live',
      turnId: 'turn_live',
      response: JSON.stringify(report)
    }
    activity.stdout(
      `${JSON.stringify({ type: 'turn.started', sessionId: 'sess_live', turnId: 'turn_live' })}\n`
    )
    activity.stdout(
      `${JSON.stringify({ type: 'model.streaming', sessionId: 'sess_live', payload: { delta: 'partial output' } })}\n`
    )
    activity.stdout(`${JSON.stringify(result)}\n`)
    expect(JSON.parse(protocol.text())).toEqual(result)
    expect(readWorkflowHeadlessReport('zcode', protocol.text())).toEqual(report)
  })
  it.each(['\n', '\r\n'])(
    'accepts the complete pretty-printed ZCode JSON envelope with %j newlines',
    (newline) => {
      const protocol = new WorkflowHeadlessProtocol('zcode')
      const activity = new WorkflowOutputActivity('ctx_zcode', (value, line) =>
        protocol.accept(value, line)
      )
      const report = { outcome: 'succeeded', body: '检查通过，23 tests passed', filesModified: [] }
      const stdout =
        JSON.stringify(
          { sessionId: 'sess_complete', response: JSON.stringify(report) },
          null,
          2
        ).replaceAll('\n', newline) + newline
      for (const byte of Buffer.from(stdout)) {
        activity.stdout(Buffer.from([byte]))
      }
      activity.endOutput()
      expect(readWorkflowHeadlessReport('zcode', protocol.text({ stdout }))).toEqual(report)
    }
  )

  it('refuses a truncated ZCode envelope instead of accepting a captured fragment', () => {
    const protocol = new WorkflowHeadlessProtocol('zcode')
    expect(() =>
      protocol.text({ stdout: '{"response":"partial"}', outputTruncated: true })
    ).toThrow('exceeded')
  })

  it.each(['dsh', 'zcode', 'codex'] as const)(
    'retains a real %s report after large tool output',
    (agent) => {
      const protocol = new WorkflowHeadlessProtocol(agent)
      const activity = new WorkflowOutputActivity('ctx_protocol', (value, line) =>
        protocol.accept(value, line)
      )
      if (agent !== 'zcode') {
        activity.stdout(
          `${JSON.stringify({ type: 'tool_result', result: 'x'.repeat(3 * 1024 * 1024) })}\n`
        )
      }
      const report = { outcome: 'succeeded', body: 'tests passed', filesModified: [] }
      const records =
        agent === 'dsh'
          ? [{ type: 'final', text: JSON.stringify(report) }]
          : agent === 'zcode'
            ? [{ response: JSON.stringify(report) }]
            : [
                { type: 'turn.started' },
                {
                  type: 'item.completed',
                  item: { type: 'agent_message', text: JSON.stringify(report) }
                },
                { type: 'turn.completed' }
              ]
      for (const record of records) {
        activity.stdout(`${JSON.stringify(record)}\n`)
      }
      activity.endOutput()
      expect(readWorkflowHeadlessReport(agent, protocol.text())).toEqual(report)
      expect(protocol.text().length).toBeLessThan(1000)
    }
  )

  it('retains provider failure evidence instead of accepting an earlier successful message', () => {
    const protocol = new WorkflowHeadlessProtocol('codex')
    for (const record of [{ type: 'turn.started' }, { type: 'turn.failed' }]) {
      protocol.accept(record, JSON.stringify(record))
    }
    expect(() => readWorkflowHeadlessReport('codex', protocol.text())).toThrow('failed')
  })
})
