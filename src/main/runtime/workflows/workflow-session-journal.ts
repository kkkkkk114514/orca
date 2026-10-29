import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import {
  workflowSessionEntrySchema,
  type WorkflowSessionEntry
} from '../../../shared/workflow-session-view'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import { publicMessage } from './public-session-message'

const maxBytes = 16 * 1024 * 1024
const pageBytes = 2 * 1024 * 1024
const marker = '.limited'

export class WorkflowSessionJournal {
  private bytes: number

  constructor(private readonly path: string) {
    this.bytes = existsSync(path) ? statSync(path).size : 0
    appendFileSync(path, '', { mode: 0o600 })
  }

  append(text: string, message?: NativeChatMessage) {
    if (text.length > 16_000 && !existsSync(this.path + marker)) {
      writeFileSync(this.path + marker, '', { mode: 0o600 })
    }
    const structured = message
      ? publicMessage({
          ...message,
          id: message.id ? `provider:${message.id}` : String(this.bytes)
        })[0]
      : undefined
    if (message && !structured) {
      return
    }
    if (structured?.limited && !existsSync(this.path + marker)) {
      writeFileSync(this.path + marker, '', { mode: 0o600 })
    }
    const entry: WorkflowSessionEntry = structured ?? {
      id: String(this.bytes),
      role: 'activity',
      at: Date.now(),
      text: text.length > 16_000 ? `${text.slice(0, 15_999)}…` : text
    }
    const line = `${JSON.stringify(entry)}\n`
    const size = Buffer.byteLength(line)
    if (this.bytes + size > maxBytes) {
      if (!existsSync(this.path + marker)) {
        writeFileSync(this.path + marker, '', { mode: 0o600 })
      }
      return
    }
    appendFileSync(this.path, line, { mode: 0o600 })
    this.bytes += size
  }
}

export async function readWorkflowSessionJournal(path: string, before?: number) {
  let file
  try {
    file = await open(path, 'r')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
  try {
    const size = (await file.stat()).size
    const end = Math.min(before ?? size, size)
    const start = Math.max(0, end - pageBytes)
    const buffer = Buffer.alloc(end - start)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
    const entries: { entry: WorkflowSessionEntry; offset: number }[] = []
    let offset = 0
    while (offset < bytesRead) {
      const newline = buffer.indexOf(10, offset)
      if (newline === -1 || newline >= bytesRead) {
        break
      }
      const lineOffset = start + offset
      const line = buffer.subarray(offset, newline).toString('utf8')
      offset = newline + 1
      if (!line || (lineOffset === start && start > 0)) {
        continue
      }
      try {
        const entry = workflowSessionEntrySchema.safeParse(JSON.parse(line))
        if (entry.success) {
          entries.push({ entry: entry.data, offset: lineOffset })
        }
      } catch {
        /* A concurrently appended final line will be read on the next poll. */
      }
    }
    const page = entries.slice(-50)
    const cursor = page[0]?.offset ?? start
    return {
      entries: page.map(({ entry }) => entry),
      before: cursor,
      hasMore: cursor > 0,
      limited: existsSync(path + marker)
    }
  } finally {
    await file.close()
  }
}
