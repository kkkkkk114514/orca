import { StringDecoder } from 'node:string_decoder'
import { stripVTControlCharacters } from 'node:util'
import { z } from 'zod'
import { redactString } from '../../observability/redactor'
import type { WorkflowStepActivity } from '../../../shared/workflow-step-activity'
import type { NativeChatBlock, NativeChatMessage } from '../../../shared/native-chat-types'

const eventSchema = z.object({
  type: z.string().default(''),
  phase: z.string().optional(),
  tool: z.string().optional(),
  status: z.string().optional(),
  text: z.string().optional(),
  result: z.string().optional(),
  response: z.string().optional(),
  id: z.string().optional(),
  call_id: z.string().optional(),
  tool_call_id: z.string().optional(),
  input: z.json().optional(),
  item: z
    .object({
      type: z.string(),
      id: z.string().optional(),
      command: z.string().optional(),
      aggregated_output: z.string().optional(),
      exit_code: z.number().int().nullable().optional(),
      text: z.string().optional(),
      status: z.string().optional(),
      changes: z
        .array(z.object({ path: z.string(), kind: z.string(), diff: z.string().optional() }))
        .optional()
    })
    .optional()
})

export class WorkflowOutputActivity {
  readonly value: WorkflowStepActivity
  private readonly decoder = new StringDecoder('utf8')
  private pending = ''
  private dropping = false
  private stderrSeen = false
  dirty = true

  constructor(
    dispatchId: string,
    private readonly onRecord?: (value: unknown, line: string) => void,
    private readonly onEntry?: (text: string, message?: NativeChatMessage) => void
  ) {
    this.value = { dispatchId, startedAt: Date.now(), state: 'running', entries: [], omitted: 0 }
    this.add('CLI started; waiting for output.')
  }

  add(text: string, message?: NativeChatMessage) {
    const clean = redactString(stripVTControlCharacters(text))
    this.onEntry?.(clean, message)
    const textTail = clean.length > 800 ? `${clean.slice(0, 799)}…` : clean
    this.value.entries.push({
      id: this.value.omitted + this.value.entries.length,
      at: Date.now(),
      text: textTail
    })
    if (this.value.entries.length > 30) {
      this.value.entries.shift()
      this.value.omitted++
    }
    this.dirty = true
  }

  stdout(chunk: Buffer | string) {
    this.value.lastOutputAt = Date.now()
    this.dirty = true
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    for (const part of text.split(/(?<=\n)/)) {
      if (!this.dropping) {
        this.pending += part
      }
      if (this.pending.length > 1024 * 1024) {
        this.pending = ''
        this.dropping = true
      }
      if (part.endsWith('\n')) {
        if (!this.dropping) {
          this.line(this.pending)
        }
        this.pending = ''
        this.dropping = false
      }
    }
  }

  stderr() {
    this.value.lastOutputAt = Date.now()
    this.dirty = true
    if (!this.stderrSeen) {
      this.stderrSeen = true
      this.add(
        'CLI emitted diagnostics on stderr; inspect authentication or permissions if it stops.'
      )
    }
  }

  finish(success: boolean, paused = false) {
    this.endOutput()
    this.value.state = success ? 'finished' : 'interrupted'
    this.add(
      paused
        ? 'Workflow paused by user; resume to continue.'
        : success
          ? 'CLI finished; completion report validated.'
          : 'Execution stopped; inspect the workflow error before resuming.'
    )
  }

  endOutput() {
    this.pending += this.decoder.end()
    if (!this.dropping && this.pending) {
      this.line(this.pending)
    }
    this.pending = ''
  }

  private line(line: string) {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return
    }
    this.onRecord?.(raw, line)
    const parsed = eventSchema.safeParse(raw)
    if (!parsed.success) {
      return
    }
    const event = parsed.data
    const message = (blocks: NativeChatBlock[], id = ''): NativeChatMessage => ({
      id,
      role: 'assistant',
      blocks,
      timestamp: Date.now(),
      source: 'transcript'
    })
    if (event.type === 'tool_call') {
      const input = z
        .object({ command: z.string().optional(), path: z.string().optional() })
        .safeParse(event.input)
      this.add(
        `Tool: ${event.tool ?? 'unknown'} ${input.success ? (input.data.command ?? input.data.path ?? '') : ''}`,
        message([
          {
            type: 'tool-call',
            name: event.tool ?? 'unknown',
            input: event.input ?? null,
            ...(event.call_id || event.id ? { callId: event.call_id ?? event.id } : {})
          }
        ])
      )
    } else if (event.type === 'tool_result') {
      this.add(
        `Tool result: ${event.status ?? 'received'}\n${event.result ?? ''}`,
        message([
          {
            type: 'tool-result',
            output: event.result ?? '',
            isError: event.status === 'failed' || event.status === 'error',
            ...(event.call_id || event.tool_call_id
              ? { callId: event.call_id ?? event.tool_call_id }
              : {})
          }
        ])
      )
    } else if (event.type === 'text') {
      if (event.text) {
        this.add(event.text, message([{ type: 'text', text: event.text }]))
      }
    } else if (event.type === 'status') {
      this.add(`CLI status: ${event.phase ?? 'updated'}`)
    } else if (event.type === 'turn.started' || event.type === 'turn.completed') {
      this.add(event.type)
    } else if (['item.started', 'item.completed'].includes(event.type) && event.item) {
      const item = event.item
      const state =
        event.type === 'item.started'
          ? ('running' as const)
          : item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0)
            ? ('failed' as const)
            : ('completed' as const)
      if (item.type === 'command_execution') {
        const blocks: NativeChatBlock[] = [
          {
            type: 'tool-call',
            name: 'shell',
            input: { command: item.command ?? '' },
            state,
            ...(item.id ? { callId: item.id } : {})
          }
        ]
        if (event.type === 'item.completed') {
          blocks.push({
            type: 'tool-result',
            output: item.aggregated_output ?? '',
            isError: state === 'failed',
            ...(item.id ? { callId: item.id } : {})
          })
        }
        this.add(
          `${event.type}: ${item.command ?? ''}\n${item.aggregated_output ?? ''}`,
          message(blocks, item.id)
        )
      } else if (item.type === 'agent_message' && item.text) {
        this.add(item.text, message([{ type: 'text', text: item.text }], item.id))
      } else if (item.type === 'file_change') {
        this.add(
          `File changes: ${item.status ?? event.type}`,
          message(
            [
              {
                type: 'tool-call',
                name: 'apply_patch',
                state,
                input: { changes: item.changes ?? [] },
                ...(item.id ? { callId: item.id } : {})
              }
            ],
            item.id
          )
        )
      }
    } else if (event.response) {
      this.add(event.response, message([{ type: 'text', text: event.response }]))
    }
  }
}
