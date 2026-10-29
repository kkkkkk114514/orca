import { z } from 'zod'
import { getAgentSessionOptionLaunchCatalog } from './agent-session-option-launch'
import type { TuiAgent } from './tui-agent'
import {
  workflowNodeSecuritySchema,
  workflowSecurityCapabilitiesSchema
} from './workflow-node-security'

const selection = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[^\r\n\0]+$/)
const selections = z
  .array(selection)
  .max(100)
  .refine((values) => new Set(values).size === values.length)

export const workflowNodeLaunchSchema = z.strictObject({
  model: selection.optional(),
  provider: selection.optional(),
  effort: selection.optional(),
  profile: selection.optional(),
  permission: selection.optional(),
  security: workflowNodeSecuritySchema.optional(),
  plugins: selections.optional(),
  mcpServers: selections.optional(),
  skills: selections.optional()
})
export type WorkflowNodeLaunch = z.infer<typeof workflowNodeLaunchSchema>

export function hasWorkflowNodeLaunch(value: WorkflowNodeLaunch | undefined): boolean {
  return Boolean(
    value &&
    Object.values(value).some((entry) => (Array.isArray(entry) ? entry.length > 0 : Boolean(entry)))
  )
}

export function workflowPermissionChoices(agent: TuiAgent): readonly string[] {
  if (agent === 'dsh') {
    return ['read-only', 'workspace-write', 'danger-full-access']
  }
  if (agent === 'zcode') {
    return ['plan', 'build', 'edit', 'guarded', 'yolo']
  }
  return []
}

export function workflowLaunchSupport(agent: TuiAgent) {
  const headless = agent === 'dsh' || agent === 'zcode'
  const catalog = getAgentSessionOptionLaunchCatalog(agent)
  return {
    model: headless || catalog?.supportsWorkerLaunchPreferences === true,
    extensions: headless,
    permissions: workflowPermissionChoices(agent)
  }
}

export const workflowNodeOptionsSchema = z.object({
  profiles: z.array(z.object({ id: z.string(), label: z.string() })),
  models: z.array(z.object({ id: z.string(), label: z.string(), provider: z.string().optional() })),
  plugins: z.array(z.object({ id: z.string(), label: z.string(), enabled: z.boolean() })),
  mcpServers: z.array(z.object({ id: z.string(), label: z.string(), enabled: z.boolean() })),
  skills: z.array(
    z.object({ id: z.string(), label: z.string(), description: z.string().nullable() })
  ),
  warnings: z.array(z.string()),
  securityCapabilities: workflowSecurityCapabilitiesSchema.optional()
})
export type WorkflowNodeOptions = z.infer<typeof workflowNodeOptionsSchema>
