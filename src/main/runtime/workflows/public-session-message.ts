import { sessionRecordBlockSchema } from '../../../shared/session-record-content'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import type { WorkflowSessionEntry } from '../../../shared/workflow-session-view'
import { redactString, redactValue } from '../../observability/redactor'
import { boundSessionRecordEntry } from './session-record-entry-bounds'

export function publicMessage(message: NativeChatMessage): WorkflowSessionEntry[] {
  if (message.role === 'reasoning') {
    return []
  }
  const blocks = message.blocks.flatMap((block) => {
    let content = block
    if (block.type === 'tool-call' && typeof block.input === 'string') {
      try {
        const input: unknown = JSON.parse(block.input)
        content = { ...block, input }
      } catch {
        if (block.name === 'apply_patch') {
          content = { ...block, input: { patch: block.input } }
        }
      }
    }
    const parsed = sessionRecordBlockSchema.safeParse(redactValue(content))
    return parsed.success ? [parsed.data] : []
  })
  const text = blocks
    .map((block) => {
      if (block.type === 'text') {
        return block.text
      }
      return block.type === 'tool-call'
        ? `${block.name}\n${JSON.stringify(block.input)}`
        : block.output
    })
    .join('\n')
  if (blocks.length === 0) {
    return []
  }
  return [
    boundSessionRecordEntry({
      id: message.id,
      role: message.role,
      text: redactString(text).slice(0, 16_000),
      ...(message.timestamp !== null ? { at: message.timestamp } : {}),
      blocks,
      ...(text.length > 16_000 ? { limited: true } : {})
    })
  ]
}
