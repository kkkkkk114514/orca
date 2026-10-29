import { z } from 'zod'
import type { WorkflowHeadlessAgent } from './workflow-headless-command'

const headerSchema = z.object({
  type: z.string().optional(),
  item: z.object({ type: z.string() }).optional()
})

export class WorkflowHeadlessProtocol {
  private readonly records: string[] = []
  private bytes = 0
  private overflow = false

  constructor(private readonly agent: WorkflowHeadlessAgent) {}

  accept(value: unknown, line: string) {
    const header = headerSchema.safeParse(value)
    if (!header.success) {
      return
    }
    const { type, item } = header.data
    const needed =
      this.agent === 'zcode'
        ? type === 'result' || type === undefined
        : this.agent === 'dsh'
          ? ['session', 'status', 'final'].includes(type ?? '')
          : ['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error'].includes(
              type ?? ''
            ) ||
            (type === 'item.completed' && item?.type === 'agent_message')
    if (!needed) {
      return
    }
    this.bytes += Buffer.byteLength(line)
    if (this.bytes > 2 * 1024 * 1024) {
      this.overflow = true
      return
    }
    this.records.push(line.trim())
  }

  text(captured?: { stdout: string; outputTruncated?: boolean }) {
    if (this.agent === 'zcode' && !this.records.length && captured) {
      if (captured.outputTruncated) {
        throw new Error(
          'ZCode completion JSON exceeded its capture limit; report was not accepted.'
        )
      }
      if (!captured.stdout.trim()) {
        throw new Error('ZCode CLI returned no JSON completion result.')
      }
      return captured.stdout
    }
    if (this.overflow) {
      throw new Error('CLI completion metadata exceeded its limit; report was not accepted.')
    }
    if (this.agent === 'zcode') {
      return this.records.at(-1) ?? ''
    }
    return this.records.join('\n')
  }
}
