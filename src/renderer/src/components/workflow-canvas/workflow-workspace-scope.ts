import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export function workflowWorkspaceScope(target: RuntimeClientTarget, worktreeId: string): string {
  return JSON.stringify([
    target.kind,
    target.kind === 'environment' ? target.environmentId : null,
    worktreeId
  ])
}

export function workflowScopedStorageKey(key: string, scope?: string): string {
  return scope ? `${key}:${scope}` : key
}
