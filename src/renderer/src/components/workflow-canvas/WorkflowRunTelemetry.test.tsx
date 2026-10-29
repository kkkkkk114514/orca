// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkflowRunTelemetry, WorkflowStepTelemetryDetails } from './WorkflowRunTelemetry'

afterEach(cleanup)

describe('workflow usage disclosure', () => {
  it('distinguishes a missing cache measurement from a reported zero and exposes resumed context', () => {
    const value = {
      dispatchId: 'ctx_example',
      sessionMode: 'resumed' as const,
      sessionId: 'session-example',
      durationMs: 2000,
      inputTokens: 100,
      cachedInputTokens: null,
      outputTokens: 7
    }
    const view = render(
      <>
        <WorkflowStepTelemetryDetails value={value} />
        <WorkflowRunTelemetry steps={[value]} />
      </>
    )
    expect(screen.getByText(/Resumed node session|已接续本节点会话/)).toBeTruthy()
    expect(screen.getByText('session-example')).toBeTruthy()
    expect(screen.getAllByText(/Not reported|未提供/).length).toBe(2)
    expect(screen.queryByText(/Input cache hit rate|输入缓存命中率/)).toBeNull()
    view.rerender(<WorkflowRunTelemetry steps={[{ ...value, cachedInputTokens: 0 }]} />)
    const summary = screen.getByLabelText(/Reported usage|已报告用量/)
    expect(within(summary).getByText(/Input cache hit rate 0.0%|输入缓存命中率 0.0%/)).toBeTruthy()
    expect(within(summary).queryByText(/Not reported|未提供/)).toBeNull()
  })
})
