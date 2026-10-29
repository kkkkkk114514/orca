import { describe, expect, it } from 'vitest'
import {
  readWorkflowHeadlessSessionOutput,
  resolveWorkflowCodexInvocationUsage
} from './workflow-headless-session-output'

describe('headless session identity and current invocation usage', () => {
  it('reads Codex cumulative session totals, retaining reported zero and missing values separately', () => {
    const events = [
      { type: 'thread.started', thread_id: '01800000-0000-4000-8000-000000000001' },
      { type: 'turn.started' },
      {
        type: 'turn.completed',
        usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 7 }
      }
    ]
    expect(
      readWorkflowHeadlessSessionOutput(
        'codex',
        events.map((event) => JSON.stringify(event)).join('\n')
      )
    ).toMatchObject({
      turnStarted: true,
      sessionId: events[0].thread_id,
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 7 }
    })
    expect(
      readWorkflowHeadlessSessionOutput(
        'codex',
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100 } })
      ).usage
    ).toEqual({ inputTokens: 100, cachedInputTokens: null, outputTokens: null })
    expect(readWorkflowHeadlessSessionOutput('codex', JSON.stringify(events[0])).turnStarted).toBe(
      false
    )
  })

  it('subtracts prior Codex session totals instead of counting previous turns again', () => {
    const previous = { inputTokens: 53090, cachedInputTokens: 39936, outputTokens: 312 }
    const current = { inputTokens: 108363, cachedInputTokens: 80000, outputTokens: 1016 }
    const stdout = [previous, current]
      .map((usage) =>
        JSON.stringify({
          type: 'turn.completed',
          usage: {
            input_tokens: usage.inputTokens,
            cached_input_tokens: usage.cachedInputTokens,
            output_tokens: usage.outputTokens
          }
        })
      )
      .join('\n')
    const output = readWorkflowHeadlessSessionOutput('codex', stdout)
    expect(output.usage).toEqual(current)
    expect(resolveWorkflowCodexInvocationUsage(output.usage, previous)).toEqual({
      inputTokens: 55273,
      cachedInputTokens: 40064,
      outputTokens: 704
    })
    expect(resolveWorkflowCodexInvocationUsage(current)).toEqual(current)
    expect(resolveWorkflowCodexInvocationUsage(current, null)).toEqual({
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null
    })
    expect(resolveWorkflowCodexInvocationUsage(previous, current)).toEqual({
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null
    })
    expect(
      resolveWorkflowCodexInvocationUsage(current, { ...previous, cachedInputTokens: null })
    ).toEqual({ inputTokens: 55273, cachedInputTokens: null, outputTokens: 704 })
    expect(resolveWorkflowCodexInvocationUsage(current, current)).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0
    })
  })

  it('sums only DSH step-end usage from this invocation and preserves incomplete reporting', () => {
    const events = [
      'diagnostic',
      JSON.stringify({ type: 'session', sessionId: 'session-example' }),
      JSON.stringify({ type: 'status', phase: 'turn_start' }),
      JSON.stringify({
        type: 'status',
        phase: 'step_end',
        usage: { inputTokens: 100, cacheReadTokens: 50, outputTokens: 5 }
      }),
      JSON.stringify({
        type: 'status',
        phase: 'step_end',
        usage: { inputTokens: 200, cacheReadTokens: 150, outputTokens: 6 }
      })
    ]
    expect(readWorkflowHeadlessSessionOutput('dsh', events.join('\n'))).toMatchObject({
      sessionId: 'session-example',
      turnStarted: true,
      usage: { inputTokens: 300, cachedInputTokens: 200, outputTokens: 11 }
    })
    events.push(JSON.stringify({ type: 'status', phase: 'step_end' }))
    expect(readWorkflowHeadlessSessionOutput('dsh', events.join('\n')).usage).toEqual({
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null
    })
  })

  it('uses ZCode turn usage instead of cumulative session projection and rejects unsafe identities', () => {
    expect(
      readWorkflowHeadlessSessionOutput(
        'zcode',
        JSON.stringify({
          sessionId: 'sess_example',
          turnId: 'turn_new',
          usage: { inputTokens: 80, cacheReadTokens: 30, outputTokens: 4 },
          projection: { totalTokenCount: 9000 }
        })
      )
    ).toMatchObject({
      sessionId: 'sess_example',
      turnStarted: true,
      usage: { inputTokens: 80, cachedInputTokens: 30, outputTokens: 4 }
    })
    expect(() =>
      readWorkflowHeadlessSessionOutput('zcode', JSON.stringify({ sessionId: '--last' }))
    ).toThrow()
    expect(() =>
      readWorkflowHeadlessSessionOutput(
        'codex',
        [
          JSON.stringify({ type: 'thread.started', thread_id: 'first' }),
          JSON.stringify({ type: 'thread.started', thread_id: 'second' })
        ].join('\n')
      )
    ).toThrow('conflicting')
  })
})
