import { isAbsolute } from 'node:path'
import type { WorkflowNodeSecurity } from '../../../shared/workflow-node-security'

const sandboxKeys = [
  'sandbox_mode',
  'sandbox_permissions',
  'default_permissions',
  'sandbox_workspace_write',
  'permissions'
]
const networkKeys = ['features.network_proxy']
const bypass = new Set([
  '--dangerously-bypass-approvals-and-sandbox',
  '--full-auto',
  '--approve-for-me'
])

export function applyWorkflowCodexSecurity(defaults: string[], security: WorkflowNodeSecurity) {
  const kept: string[] = []
  const overridesKey = (key: string) =>
    (security.access &&
      sandboxKeys.some((prefix) => key === prefix || key.startsWith(`${prefix}.`))) ||
    (security.approval && ['approval_policy', 'approvals_reviewer'].includes(key)) ||
    (security.network &&
      networkKeys.some((prefix) => key === prefix || key.startsWith(`${prefix}.`)))
  for (let index = 0; index < defaults.length; index++) {
    const token = defaults[index]
    if (bypass.has(token) && (security.access || security.approval)) {
      continue
    }
    const flag = token.split('=')[0]
    if (
      security.network &&
      ['--enable', '--disable'].includes(flag) &&
      (token.includes('=') ? token.slice(token.indexOf('=') + 1) : defaults[index + 1]) ===
        'network_proxy'
    ) {
      if (!token.includes('=')) {
        index++
      }
      continue
    }
    if (
      (security.access && ['-s', '--sandbox', '--add-dir'].includes(flag)) ||
      (security.approval && ['-a', '--ask-for-approval'].includes(flag))
    ) {
      if (!token.includes('=')) {
        index++
      }
      continue
    }
    if (token === '-c' || token === '--config') {
      const assignment = defaults[index + 1] ?? ''
      if (overridesKey(assignment.split('=')[0].trim())) {
        index++
        continue
      }
      kept.push(token, assignment)
      index++
      continue
    }
    const assignment = token.startsWith('--config=')
      ? token.slice(9)
      : token.startsWith('-c') && token.length > 2
        ? token.slice(2)
        : undefined
    if (assignment && overridesKey(assignment.split('=')[0].trim())) {
      continue
    }
    if (security.access && /^-s[^-]/.test(token)) {
      continue
    }
    if (security.approval && /^-a[^-]/.test(token)) {
      continue
    }
    kept.push(token)
  }
  const config = (key: string, value: unknown) =>
    kept.push('--config', `${key}=${JSON.stringify(value)}`)
  if (security.access) {
    kept.push(
      '--sandbox',
      security.access === 'full-access' ? 'danger-full-access' : security.access
    )
    const roots = [...new Set(security.writableDirectories ?? [])]
    if (roots.some((path) => !isAbsolute(path))) {
      throw new Error('Writable directories must be absolute paths on the execution host.')
    }
    config('sandbox_workspace_write.writable_roots', roots)
  }
  if (security.approval) {
    config('approval_policy', security.approval)
    config('approvals_reviewer', 'user')
  }
  if (security.network) {
    config('sandbox_workspace_write.network_access', security.network !== 'deny')
    if (security.network === 'restricted') {
      const domains = (security.allowedHosts ?? [])
        .map((host) => `${JSON.stringify(host)} = "allow"`)
        .join(', ')
      kept.push('--config', `features.network_proxy={ enabled = true, domains = { ${domains} } }`)
    } else {
      config('features.network_proxy', false)
    }
  }
  return kept
}
