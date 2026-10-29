import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../../shared/mobile-bridge-frame-bytes'
import type { WorkflowSessionPage } from '../../../shared/workflow-session-view'
import { boundSessionRecordEntry } from './session-record-entry-bounds'

export function boundWorkflowSessionPage(page: WorkflowSessionPage): WorkflowSessionPage {
  let result = page
  let length = 16_000
  while (Buffer.byteLength(JSON.stringify(result)) > MOBILE_BRIDGE_MAX_FRAME_BYTES / 2) {
    if (length === 0) {
      throw new Error('Workflow session metadata exceeds the read limit')
    }
    length = Math.floor(length / 2)
    const excerpt = (text: string) => (text.length > length ? `${text.slice(0, length)}…` : text)
    result = {
      ...result,
      limited: true,
      entries: result.entries.map((entry) => boundSessionRecordEntry(entry, length)),
      task: excerpt(result.task),
      instructions: excerpt(result.instructions),
      ...(result.control
        ? {
            control: {
              ...result.control,
              pendingMessages: result.control.pendingMessages.map((message) => ({
                ...message,
                text: excerpt(message.text)
              }))
            }
          }
        : {}),
      ...(result.report ? { report: excerpt(result.report) } : {})
    }
  }
  return result
}
