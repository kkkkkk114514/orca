import { z } from 'zod'
import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'
import {
  hasWorkflowNodeLaunch,
  workflowNodeLaunchSchema,
  workflowLaunchSupport
} from './workflow-node-launch'
import { checkAgentLaunchModelPreferences } from './agent-launch-model-preferences'
import { workflowNodeSecurityIssue } from './workflow-node-security'
import { workflowNodeConversationSchema } from './workflow-node-conversation'

const nodeId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
const outcome = z.enum(['succeeded', 'failed'])
const nodeSchema = z.discriminatedUnion('type', [
  z.strictObject({
    id: nodeId,
    type: z.literal('agent'),
    agent: z.custom<TuiAgent>(isTuiAgent, 'Choose an agent supported by Orca'),
    launch: workflowNodeLaunchSchema.optional(),
    conversation: workflowNodeConversationSchema.optional(),
    prompt: z
      .string()
      .min(1)
      .max(64_000)
      .refine((value) => value.trim().length > 0, {
        message: 'An agent prompt cannot be blank'
      }),
    onSuccess: nodeId,
    onFailure: nodeId
  }),
  z.strictObject({ id: nodeId, type: z.literal('end'), outcome })
])

function collectReachable(starts: string[], edges: Map<string, string[]>): Set<string> {
  const visited = new Set<string>()
  const pending = [...starts]
  while (pending.length > 0) {
    const id = pending.pop()
    if (id === undefined || visited.has(id)) {
      continue
    }
    visited.add(id)
    pending.push(...(edges.get(id) ?? []))
  }
  return visited
}

export const workflowDefinitionSchema = z
  .strictObject({
    version: z.union([z.literal(1), z.literal(2)]),
    name: z.string().trim().min(1).max(120),
    entry: nodeId,
    maxSteps: z.number().int().min(1).max(1000),
    nodes: z.array(nodeSchema).min(1).max(100)
  })
  .superRefine((definition, context) => {
    for (const [index, node] of definition.nodes.entries()) {
      if (node.type === 'agent' && node.conversation && definition.version !== 2) {
        context.addIssue({
          code: 'custom',
          path: ['version'],
          message: 'Node conversation selection requires workflow version 2.'
        })
      }
      if (node.type !== 'agent' || !hasWorkflowNodeLaunch(node.launch)) {
        continue
      }
      if (definition.version !== 2) {
        context.addIssue({
          code: 'custom',
          path: ['version'],
          message: 'Node launch overrides require workflow version 2.'
        })
      }
      const support = workflowLaunchSupport(node.agent)
      const launch = node.launch
      if (!launch) {
        continue
      }
      if (launch.security) {
        const issue = launch.permission
          ? 'Choose independent permissions or a legacy CLI mode, not both.'
          : workflowNodeSecurityIssue(node.agent, launch.security)
        if (issue) {
          context.addIssue({
            code: 'custom',
            path: ['nodes', index, 'launch', 'security'],
            message: issue
          })
        }
      }
      if (node.agent !== 'dsh' && node.agent !== 'zcode') {
        const checked = checkAgentLaunchModelPreferences({
          agent: node.agent,
          model: launch.model,
          effort: launch.effort,
          openCodeModelLaunchSupported: true
        })
        if ('refusal' in checked) {
          context.addIssue({
            code: 'custom',
            path: ['nodes', index, 'launch'],
            message: checked.refusal.message
          })
        }
      }
      if ((launch.model || launch.effort) && !support.model) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'launch'],
          message: 'This agent does not support workflow model selection.'
        })
      }
      if (launch.permission && !support.permissions.includes(launch.permission)) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'launch', 'permission'],
          message: 'This agent does not support that permission mode.'
        })
      }
      if (
        !support.extensions &&
        (launch.profile ||
          launch.provider ||
          launch.plugins?.length ||
          launch.mcpServers?.length ||
          launch.skills?.length)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'launch'],
          message: 'CLI extension overrides currently require a DSH or ZCode canvas node.'
        })
      }
    }
    const ids = new Set<string>()
    for (const [index, node] of definition.nodes.entries()) {
      if (ids.has(node.id)) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'id'],
          message: `Duplicate node ID: ${node.id}`
        })
      }
      ids.add(node.id)
    }
    if (ids.size !== definition.nodes.length) {
      return
    }

    if (!ids.has(definition.entry)) {
      context.addIssue({ code: 'custom', path: ['entry'], message: 'Entry node does not exist' })
    }

    const outgoing = new Map<string, string[]>()
    const incoming = new Map<string, string[]>()
    const ends: string[] = []
    for (const node of definition.nodes) {
      outgoing.set(node.id, [])
      incoming.set(node.id, [])
      if (node.type === 'end') {
        ends.push(node.id)
      }
    }
    if (ends.length === 0) {
      context.addIssue({ code: 'custom', path: ['nodes'], message: 'Add at least one end node' })
    }

    for (const [index, node] of definition.nodes.entries()) {
      if (node.type === 'end') {
        continue
      }
      for (const field of ['onSuccess', 'onFailure'] as const) {
        const target = node[field]
        if (!ids.has(target)) {
          context.addIssue({
            code: 'custom',
            path: ['nodes', index, field],
            message: `Target node does not exist: ${target}`
          })
          continue
        }
        outgoing.get(node.id)?.push(target)
        incoming.get(target)?.push(node.id)
      }
    }

    const reachable = collectReachable([definition.entry], outgoing)
    const canFinish = collectReachable(ends, incoming)
    for (const [index, node] of definition.nodes.entries()) {
      if (!reachable.has(node.id)) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'id'],
          message: `Node is unreachable from the entry: ${node.id}`
        })
      }
      if (!canFinish.has(node.id)) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'id'],
          message: `Node has no path to an end: ${node.id}`
        })
      }
    }
  })

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>
export type WorkflowNode = WorkflowDefinition['nodes'][number]

export function withWorkflowConversationDefaults(
  definition: WorkflowDefinition
): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    ...definition,
    version: definition.nodes.some((node) => node.type === 'agent') ? 2 : definition.version,
    nodes: definition.nodes.map((node) =>
      node.type === 'agent'
        ? { ...node, conversation: node.conversation ?? { mode: 'latest' } }
        : node
    )
  })
}
