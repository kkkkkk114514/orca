import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { createUuidV4 } from '../../../../shared/uuid-v4'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  withWorkflowConversationDefaults,
  type WorkflowDefinition
} from '../../../../shared/workflow-definition'
import {
  workflowRunSnapshotSchema,
  type WorkflowRunSnapshot
} from '../../../../shared/workflow-run-contract'
import { translate } from '@/i18n/i18n'
import { workflowScopedStorageKey, workflowWorkspaceScope } from './workflow-workspace-scope'

const bindingSchema = z.object({
  id: z.string().uuid(),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local') }),
    z.object({ kind: z.literal('environment'), environmentId: z.string().min(1) })
  ]),
  workspaceLabel: z.string(),
  workflowId: z.string().uuid().optional(),
  worktreeId: z.string().optional()
})
type Binding = z.infer<typeof bindingSchema>
const storageKey = 'orca.workflow-run.v1'

function readBinding(scope?: string): Binding | null {
  try {
    const key = workflowScopedStorageKey(storageKey, scope)
    const value = localStorage.getItem(key)
    if (value) {
      const binding = bindingSchema.parse(JSON.parse(value))
      return !scope ||
        (binding.worktreeId && workflowWorkspaceScope(binding.target, binding.worktreeId) === scope)
        ? binding
        : null
    }
    const legacy = scope ? localStorage.getItem(storageKey) : null
    const binding = legacy ? bindingSchema.parse(JSON.parse(legacy)) : null
    if (
      binding?.worktreeId &&
      workflowWorkspaceScope(binding.target, binding.worktreeId) === scope
    ) {
      localStorage.setItem(key, JSON.stringify(binding))
      localStorage.removeItem(storageKey)
      return binding
    }
    return null
  } catch {
    return null
  }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return /method.not.found|unknown.method|unsupported.*method/i.test(message)
    ? translate(
        'workflows.upgradeHost',
        'This host does not support workflow runs. Update the execution host and reconnect.'
      )
    : message
}

function isMissingRun(error: unknown): boolean {
  return (
    error instanceof Error &&
    /\bENOENT\b/.test(error.message) &&
    /[/\\]run\.json(?:['"\s]|$)/.test(error.message)
  )
}

export function useWorkflowRun(scope?: string, onStarted?: () => void) {
  const [binding, setBinding] = useState(() => readBinding(scope))
  const runStorageKey = workflowScopedStorageKey(storageKey, scope)
  const startAccepted = useRef(onStarted)
  startAccepted.current = onStarted
  const [snapshot, setSnapshot] = useState<WorkflowRunSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false)
  const startFailure = useRef<{ id: string; message: string } | null>(null)
  const current = useRef(binding)
  current.current = binding

  const call = useCallback(
    async (selected: Binding, method: string, params: unknown, signal?: AbortSignal) => {
      const result = workflowRunSnapshotSchema.parse(
        await callRuntimeRpc<unknown>(selected.target, method, params, {
          suppressFeatureInteraction: method === 'workflow.show',
          signal
        })
      )
      if (result.id !== selected.id) {
        throw new Error('Workflow run identity mismatch')
      }
      if (!signal?.aborted && current.current?.id === selected.id) {
        startFailure.current = null
        setSnapshot(result)
        setError('')
        if (method === 'workflow.start') {
          startAccepted.current?.()
        }
      }
    },
    []
  )

  useEffect(() => {
    if (!binding) {
      return
    }
    let cancelled = false
    let refreshing = false
    const controller = new AbortController()
    const refresh = async (): Promise<void> => {
      if (!busyRef.current && !refreshing) {
        refreshing = true
        try {
          await call(binding, 'workflow.show', { id: binding.id }, controller.signal)
        } catch (failure) {
          if (!cancelled && current.current?.id === binding.id) {
            setError(
              isMissingRun(failure) && startFailure.current?.id === binding.id
                ? startFailure.current.message
                : describeError(failure)
            )
          }
        } finally {
          refreshing = false
        }
      }
    }
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
      controller.abort()
    }
  }, [binding, call])

  const command = async (selected: Binding, method: string, params: unknown): Promise<void> => {
    if (busyRef.current) {
      return
    }
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await call(selected, method, params)
    } catch (failure) {
      const message = describeError(failure)
      if (method === 'workflow.start') {
        startFailure.current = { id: selected.id, message }
        if (failure instanceof RuntimeRpcCallError) {
          try {
            await call(selected, 'workflow.show', { id: selected.id })
          } catch (probe) {
            if (
              probe instanceof RuntimeRpcCallError &&
              isMissingRun(probe) &&
              current.current?.id === selected.id
            ) {
              try {
                localStorage.removeItem(runStorageKey)
              } catch (storageError) {
                setError(`${message}\n${describeError(storageError)}`)
                return
              }
              current.current = null
              setBinding(null)
              setSnapshot(null)
            }
          }
        }
      }
      setError(message)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const start = async (
    definition: WorkflowDefinition,
    input: string,
    target: RuntimeClientTarget,
    worktreeId: string,
    workspaceLabel: string,
    workflowId?: string
  ): Promise<void> => {
    if (busyRef.current || current.current) {
      return
    }
    if (scope && workflowWorkspaceScope(target, worktreeId) !== scope) {
      setError(
        translate(
          'workflows.workspaceChanged',
          'The execution workspace changed. Reopen its workflow before running.'
        )
      )
      return
    }
    const next: Binding = { id: createUuidV4(), target, workspaceLabel, workflowId, worktreeId }
    try {
      localStorage.setItem(runStorageKey, JSON.stringify(next))
    } catch {
      setError(
        translate(
          'workflows.runStorageFailed',
          'Cannot save the run reference on this device. Free device storage before starting.'
        )
      )
      return
    }
    current.current = next
    setBinding(next)
    await command(next, 'workflow.start', {
      id: next.id,
      definition: withWorkflowConversationDefaults(definition),
      input,
      worktree: `id:${worktreeId}`,
      ...(workflowId ? { workflowId } : {})
    })
  }

  const detach = (): void => {
    if (busyRef.current) {
      return
    }
    try {
      localStorage.removeItem(runStorageKey)
    } catch (failure) {
      setError(describeError(failure))
      return
    }
    current.current = null
    startFailure.current = null
    setBinding(null)
    setSnapshot(null)
    setError('')
  }

  return {
    binding,
    snapshot,
    busy,
    error,
    start,
    clear: () => {
      if (snapshot && ['succeeded', 'failed'].includes(snapshot.phase)) {
        detach()
      }
    },
    detach,
    pause: () => binding && command(binding, 'workflow.pause', { id: binding.id }),
    resume: () => binding && command(binding, 'workflow.resume', { id: binding.id })
  }
}
