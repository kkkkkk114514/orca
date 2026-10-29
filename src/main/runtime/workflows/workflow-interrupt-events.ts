const listeners = new WeakMap<object, (handle: string) => void>()

export function registerWorkflowInterruptListener(
  runtime: object,
  listener: (handle: string) => void
) {
  listeners.set(runtime, listener)
  return () => listeners.delete(runtime)
}

export function notifyWorkflowAgentInterrupted(runtime: object, handle: string) {
  listeners.get(runtime)?.(handle)
}
