import { z } from 'zod'
import {
  workflowSessionIdSchema,
  type WorkflowTokenUsage
} from '../../../shared/workflow-step-telemetry'
import type { WorkflowHeadlessAgent } from './workflow-headless-command'

const count = z.number().int().nonnegative().safe().optional()
const camelUsage = z.object({ inputTokens: count, cacheReadTokens: count, outputTokens: count })
const codexUsage = z.object({
  input_tokens: count,
  cached_input_tokens: count,
  output_tokens: count
})
const emptyUsage = (): WorkflowTokenUsage => ({
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null
})

export function readWorkflowHeadlessSessionOutput(agent: WorkflowHeadlessAgent, stdout: string) {
  const ids = new Set<string>()
  const usages: WorkflowTokenUsage[] = []
  const values: unknown[] = []
  let turnStarted = false
  for (const line of agent === 'zcode' ? [stdout] : stdout.split('\n')) {
    try {
      values.push(JSON.parse(line))
    } catch {
      // DSH can mix diagnostics with its JSON stream.
    }
  }
  for (const value of values) {
    const parsed = z
      .object({
        type: z.string().optional(),
        phase: z.string().optional(),
        sessionId: z.unknown().optional(),
        thread_id: z.unknown().optional(),
        turnId: z.string().optional(),
        usage: z.unknown().optional()
      })
      .safeParse(value)
    if (!parsed.success) {
      continue
    }
    const event = parsed.data
    turnStarted ||=
      agent === 'codex'
        ? event.type === 'turn.started'
        : agent === 'dsh'
          ? event.type === 'status' && event.phase === 'turn_start'
          : Boolean(event.turnId)
    const id =
      agent === 'codex' && event.type === 'thread.started'
        ? event.thread_id
        : agent === 'zcode' || (agent === 'dsh' && event.type === 'session')
          ? event.sessionId
          : undefined
    if (id !== undefined) {
      ids.add(workflowSessionIdSchema.parse(id))
    }
    if (agent === 'codex' && event.type === 'turn.completed') {
      const usage = codexUsage.safeParse(event.usage)
      usages.push(
        usage.success
          ? {
              inputTokens: usage.data.input_tokens ?? null,
              cachedInputTokens: usage.data.cached_input_tokens ?? null,
              outputTokens: usage.data.output_tokens ?? null
            }
          : emptyUsage()
      )
    } else if (
      agent === 'zcode' ||
      (agent === 'dsh' && event.type === 'status' && event.phase === 'step_end')
    ) {
      const usage = camelUsage.safeParse(event.usage)
      usages.push(
        usage.success
          ? {
              inputTokens: usage.data.inputTokens ?? null,
              cachedInputTokens: usage.data.cacheReadTokens ?? null,
              outputTokens: usage.data.outputTokens ?? null
            }
          : emptyUsage()
      )
    }
  }
  if (ids.size > 1) {
    throw new Error('CLI output contains conflicting session identities.')
  }
  const sum = (key: keyof WorkflowTokenUsage) =>
    usages.length && usages.every((usage) => usage[key] !== null)
      ? usages.reduce((total, usage) => total + (usage[key] ?? 0), 0)
      : null
  const usage: WorkflowTokenUsage =
    agent === 'codex'
      ? (usages.at(-1) ?? emptyUsage())
      : {
          inputTokens: sum('inputTokens'),
          cachedInputTokens: sum('cachedInputTokens'),
          outputTokens: sum('outputTokens')
        }
  if (
    usage.inputTokens !== null &&
    usage.cachedInputTokens !== null &&
    usage.cachedInputTokens > usage.inputTokens
  ) {
    usage.cachedInputTokens = null
  }
  return { sessionId: ids.values().next().value, usage, turnStarted }
}

export function resolveWorkflowCodexInvocationUsage(
  current: WorkflowTokenUsage,
  previous?: WorkflowTokenUsage | null
): WorkflowTokenUsage {
  if (previous === undefined) {
    return current
  }
  if (
    !previous ||
    (current.inputTokens !== null &&
      previous.inputTokens !== null &&
      current.inputTokens < previous.inputTokens)
  ) {
    return emptyUsage()
  }
  const delta = (key: keyof WorkflowTokenUsage) => {
    const now = current[key]
    const before = previous[key]
    return now !== null && before !== null && now >= before ? now - before : null
  }
  const usage = {
    inputTokens: delta('inputTokens'),
    cachedInputTokens: delta('cachedInputTokens'),
    outputTokens: delta('outputTokens')
  }
  if (
    usage.inputTokens !== null &&
    usage.cachedInputTokens !== null &&
    usage.cachedInputTokens > usage.inputTokens
  ) {
    usage.cachedInputTokens = null
  }
  return usage
}
