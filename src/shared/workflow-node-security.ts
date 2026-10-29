import { z } from 'zod'
import type { TuiAgent } from './tui-agent'

const path = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .regex(/^[^\r\n\0]+$/)
const host = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .refine((value) => {
    const plain = value.startsWith('*.') ? value.slice(2) : value
    return plain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  }, 'Enter a hostname, optionally starting with *., without a URL, port or path.')
const access = z.enum(['read-only', 'workspace-write', 'full-access'])
const approval = z.enum(['on-request', 'never'])
const network = z.enum(['allow', 'restricted', 'deny'])

export const workflowNodeSecuritySchema = z
  .strictObject({
    access: access.optional(),
    approval: approval.optional(),
    network: network.optional(),
    writableDirectories: z.array(path).max(20).optional(),
    allowedHosts: z.array(host).max(100).optional()
  })
  .superRefine((value, ctx) => {
    if (value.writableDirectories?.length && value.access !== 'workspace-write') {
      ctx.addIssue({
        code: 'custom',
        path: ['writableDirectories'],
        message: 'Additional writable directories require workspace-write access.'
      })
    }
    if (value.network && value.access !== 'workspace-write') {
      ctx.addIssue({
        code: 'custom',
        path: ['network'],
        message: 'Explicit command network policy currently requires workspace-write access.'
      })
    }
    if (value.network === 'restricted' && !value.allowedHosts?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedHosts'],
        message: 'Restricted network access requires at least one allowed hostname.'
      })
    }
    if (value.allowedHosts?.length && value.network !== 'restricted') {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedHosts'],
        message: 'Allowed hostnames require restricted network access.'
      })
    }
  })
export type WorkflowNodeSecurity = z.infer<typeof workflowNodeSecuritySchema>
export const workflowSecurityCapabilitiesSchema = z.object({
  access: z.array(access),
  approval: z.array(approval),
  network: z.array(network),
  writableDirectories: z.boolean()
})
export type WorkflowSecurityCapabilities = z.infer<typeof workflowSecurityCapabilitiesSchema>

export function workflowSecurityCapabilities(agent: TuiAgent): WorkflowSecurityCapabilities {
  return {
    access:
      agent === 'dsh' || agent === 'codex' ? ['read-only', 'workspace-write', 'full-access'] : [],
    approval: agent === 'dsh' || agent === 'codex' ? ['on-request', 'never'] : [],
    network: agent === 'codex' ? ['allow', 'restricted', 'deny'] : [],
    writableDirectories: agent === 'codex'
  }
}

export function workflowNodeSecurityIssue(
  agent: TuiAgent,
  value: WorkflowNodeSecurity
): string | undefined {
  const support = workflowSecurityCapabilities(agent)
  if (
    (value.access && !support.access.includes(value.access)) ||
    (value.approval && !support.approval.includes(value.approval)) ||
    (value.network && !support.network.includes(value.network)) ||
    (value.writableDirectories?.length && !support.writableDirectories)
  ) {
    return 'This CLI does not support the selected independent node permissions.'
  }
  return undefined
}

export function inheritedDshSecurity(permission?: string): WorkflowNodeSecurity | undefined {
  if (!permission) {
    return undefined
  }
  return {
    access:
      permission === 'danger-full-access'
        ? 'full-access'
        : permission === 'read-only'
          ? 'read-only'
          : 'workspace-write',
    approval: permission === 'danger-full-access' ? 'never' : 'on-request'
  }
}
