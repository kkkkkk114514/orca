import { useSyncExternalStore } from 'react'

type AutomationWorkspaceView = 'schedules' | 'workflows'
let view: AutomationWorkspaceView = 'schedules'
const listeners = new Set<() => void>()

export function setAutomationWorkspaceView(next: AutomationWorkspaceView): void {
  view = next
  for (const listener of listeners) {
    listener()
  }
}

export function useAutomationWorkspaceView(): AutomationWorkspaceView {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => view
  )
}
