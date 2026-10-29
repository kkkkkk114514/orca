import { useRef, useState } from 'react'
import { ArrowUp, LoaderCircle, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { createUuidV4 } from '../../../../shared/uuid-v4'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { WorkflowSessionPage } from '../../../../shared/workflow-session-view'
import { NativeChatPromptEditor } from '../native-chat/NativeChatPromptEditor'
import type { NativeChatComposerInput } from '../native-chat/native-chat-composer-input'
import { SessionRecordEntries } from './SessionRecordEntries'

export function WorkflowSessionComposer({
  page,
  target
}: {
  page: WorkflowSessionPage
  target: RuntimeClientTarget
}) {
  const input = useRef<NativeChatComposerInput | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [paused, setPaused] = useState(page.control?.paused ?? false)
  const lastPaused = useRef(page.control?.paused)
  if (lastPaused.current !== page.control?.paused) {
    lastPaused.current = page.control?.paused
    setPaused(page.control?.paused ?? false)
  }
  const retry = useRef<{ text: string; requestId: string } | null>(null)
  const control = async (action: 'interrupt' | 'message' | 'resume') => {
    if (busy) {
      return
    }
    const text = (input.current?.value ?? draft).trim()
    if (action === 'message' && !text) {
      return
    }
    setBusy(true)
    setError('')
    try {
      if (action === 'resume') {
        await callRuntimeRpc(target, 'workflow.resume', { id: page.id })
        setPaused(false)
      } else {
        if (!retry.current || retry.current.text !== text) {
          retry.current = { text, requestId: createUuidV4() }
        }
        await callRuntimeRpc(target, 'workflow.sessionControl', {
          id: page.id,
          nodeId: page.nodeId,
          dispatchId: page.dispatchId,
          requestId: retry.current.requestId,
          action,
          ...(action === 'message' ? { text } : {})
        })
        setPaused(true)
        if (action === 'message') {
          setDraft('')
          if (input.current) {
            input.current.value = ''
          }
        }
        retry.current = null
      }
      window.dispatchEvent(new Event('workspace-session-history-changed'))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="shrink-0 border-t p-3" data-testid="workflow-session-composer">
      <div className="mx-auto max-w-4xl space-y-2">
        {page.control?.pendingMessages.length ? (
          <div className="max-h-32 overflow-auto scrollbar-sleek">
            <SessionRecordEntries
              entries={page.control.pendingMessages.map((message) => ({
                id: `pending:${message.id}`,
                role: 'user',
                text: message.text
              }))}
            />
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground" role="status">
          {paused
            ? translate(
                'workflows.sessionPaused',
                'Workflow paused. Supplements will be sent when you resume.'
              )
            : translate(
                'workflows.sessionSendPauses',
                'Sending a supplement pauses the whole workflow. Resume to continue.'
              )}
        </p>
        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="rounded-md border p-2">
          <NativeChatPromptEditor
            inputRef={input}
            scopeKey={`workflow:${page.id}:${page.dispatchId}`}
            initialValue=""
            disabled={busy}
            placeholder={translate(
              'workflows.sessionSupplement',
              'Add instructions for this node…'
            )}
            onChange={(editor) => setDraft(editor.value)}
            onSelect={() => {}}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                event.nativeEvent.keyCode !== 229
              ) {
                event.preventDefault()
                void control('message')
              }
            }}
          />
          <div className="flex items-center justify-end gap-2 pt-2">
            {busy && (
              <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            )}
            {paused ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || Boolean(draft.trim())}
                onClick={() => void control('resume')}
              >
                <Play />
                {translate('workflows.sessionResume', 'Resume')}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void control('interrupt')}
              >
                <Square />
                {translate('workflows.sessionInterrupt', 'Interrupt workflow')}
              </Button>
            )}
            <Button
              size="sm"
              disabled={busy || !draft.trim()}
              onClick={() => void control('message')}
            >
              <ArrowUp />
              {translate('workflows.sessionSendSupplement', 'Send supplement')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
