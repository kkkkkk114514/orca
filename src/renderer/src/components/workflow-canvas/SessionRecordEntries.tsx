import type { WorkflowSessionEntry } from '../../../../shared/workflow-session-view'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { useMemo } from 'react'
import { MessageRow } from '../native-chat/NativeChatMessageRow'
import { foldToolMessages } from '../../../../shared/native-chat-tool-fold'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from '../native-chat/native-chat-disclosure-store'
import {
  NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
  NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS
} from '../native-chat/native-chat-appearance-style'
import { useNativeChatStoreAppearanceStyle } from '../native-chat/use-native-chat-store-appearance-style'

export function SessionRecordEntries({
  entries,
  working = false
}: {
  entries: WorkflowSessionEntry[]
  working?: boolean
}) {
  const style = useNativeChatStoreAppearanceStyle()
  const disclosures = useNativeChatDisclosures()
  const messages = useMemo(
    () =>
      foldToolMessages(
        entries.map((entry): NativeChatMessage => ({
          id: entry.id,
          role: entry.role === 'activity' ? 'system' : entry.role,
          timestamp: entry.at ?? null,
          source: 'transcript',
          blocks: entry.blocks?.length ? entry.blocks : [{ type: 'text', text: entry.text }]
        }))
      ),
    [entries]
  )
  return (
    <NativeChatDisclosureContext.Provider value={disclosures}>
      <div
        className={NATIVE_CHAT_APPEARANCE_ROOT_CLASS}
        style={style}
        data-session-native-transcript
      >
        <div className={NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS}>
          {messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              expandSignal={false}
              activeTurnIsWorking={working ? undefined : false}
              onScrollMessageToTop={(element) => element.scrollIntoView({ block: 'nearest' })}
            />
          ))}
        </div>
      </div>
    </NativeChatDisclosureContext.Provider>
  )
}
