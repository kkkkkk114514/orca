import { describe, expect, it } from 'vitest'
import { summarizeWorkflowTelemetry, type WorkflowStepTelemetry } from './workflow-step-telemetry'

describe('workflow invocation usage totals', () => {
  it('counts each completed invocation once and computes the weighted cache rate', () => {
    const base = {
      dispatchId: 'ctx_first',
      sessionId: 'session',
      sessionMode: 'new' as const,
      durationMs: 1000,
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 10
    }
    expect(
      summarizeWorkflowTelemetry([
        base,
        {
          ...base,
          dispatchId: 'ctx_second',
          sessionMode: 'resumed',
          durationMs: 2000,
          inputTokens: 900,
          cachedInputTokens: 800
        }
      ])
    ).toEqual({
      inputTokens: 1000,
      cachedInputTokens: 800,
      outputTokens: 20,
      durationMs: 3000,
      reportedSteps: 2,
      cacheHitRate: 0.8
    })
  })
  it('never turns unavailable usage into a zero or a misleading partial cache percentage', () => {
    const missing: WorkflowStepTelemetry = {
      dispatchId: 'ctx_missing',
      sessionMode: 'unavailable',
      durationMs: 500,
      inputTokens: 100,
      cachedInputTokens: null,
      outputTokens: null
    }
    expect(summarizeWorkflowTelemetry([missing])).toMatchObject({
      inputTokens: 100,
      cachedInputTokens: null,
      outputTokens: null,
      cacheHitRate: null,
      reportedSteps: 0
    })
    expect(summarizeWorkflowTelemetry([])).toMatchObject({
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      cacheHitRate: null
    })
  })
})
