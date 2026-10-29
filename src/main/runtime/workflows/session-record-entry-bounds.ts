import type { WorkflowSessionEntry } from '../../../shared/workflow-session-view'

export function boundSessionRecordEntry(
  entry: WorkflowSessionEntry,
  budget = 64_000
): WorkflowSessionEntry {
  if (
    (entry.blocks?.length ?? 0) <= 100 &&
    entry.text.length <= 16_000 &&
    Buffer.byteLength(JSON.stringify(entry)) <= budget
  ) {
    return entry
  }
  let length = 16_000
  let count = Math.min(entry.blocks?.length ?? 0, 100)
  let limited = Boolean(entry.limited || (entry.blocks?.length ?? 0) > count)
  for (;;) {
    const excerpt = (text: string) => {
      if (text.length <= length) {
        return text
      }
      limited = true
      return `${text.slice(0, length)}…`
    }
    const blocks = entry.blocks?.slice(0, count).map((block) => {
      if (block.type === 'text') {
        return { ...block, text: excerpt(block.text) }
      }
      if (block.type === 'tool-call') {
        const serialized = JSON.stringify(block.input)
        return { ...block, input: serialized.length > length ? excerpt(serialized) : block.input }
      }
      const { editPatch, ...result } = block
      if (editPatch && JSON.stringify(editPatch).length > length) {
        limited = true
      }
      return {
        ...result,
        output: excerpt(block.output),
        ...(editPatch && JSON.stringify(editPatch).length <= length ? { editPatch } : {})
      }
    })
    const text = excerpt(entry.text)
    const result = {
      ...entry,
      text,
      ...(blocks ? { blocks } : {}),
      ...(limited ? { limited: true } : {})
    }
    if (Buffer.byteLength(JSON.stringify(result)) <= budget) {
      return result
    }
    limited = true
    if (length > 0) {
      length = Math.floor(length / 2)
    } else if (count > 0) {
      count = Math.floor(count / 2)
    } else {
      throw new Error('Session record metadata exceeds the read limit')
    }
  }
}
