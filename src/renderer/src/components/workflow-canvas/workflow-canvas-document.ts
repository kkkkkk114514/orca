import { z } from 'zod'
import type { Connection, Edge, Node } from '@xyflow/react'
import {
  workflowDefinitionSchema,
  type WorkflowDefinition
} from '../../../../shared/workflow-definition'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { createUuidV4 } from '../../../../shared/uuid-v4'
import { workflowNodeConversationSchema } from '../../../../shared/workflow-node-conversation'
import {
  hasWorkflowNodeLaunch,
  workflowNodeLaunchSchema
} from '../../../../shared/workflow-node-launch'

const dataSchema = z.object({
  label: z.string().max(120),
  kind: z.enum(['agent', 'end']),
  agent: z.custom<TuiAgent>(isTuiAgent),
  prompt: z.string().max(64_000),
  launch: workflowNodeLaunchSchema.optional(),
  conversation: workflowNodeConversationSchema.optional(),
  outcome: z.enum(['succeeded', 'failed'])
})
export type WorkflowCanvasNodeData = z.infer<typeof dataSchema>
export type WorkflowCanvasNode = Node<WorkflowCanvasNodeData, 'workflow'>
export type WorkflowCanvasEdge = Edge

const coordinate = z.number().finite().min(-1_000_000).max(1_000_000)
export const workflowCanvasDocumentSchema = z
  .object({
    format: z.literal('orca-workflow-canvas'),
    workflowId: z.string().uuid().optional(),
    version: z.union([z.literal(1), z.literal(2)]),
    name: z.string().max(120),
    entry: z.string().max(64),
    maxSteps: z.number().int().min(1).max(1000),
    nodes: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          type: z.literal('workflow'),
          position: z.object({ x: coordinate, y: coordinate }),
          data: dataSchema
        })
      )
      .max(100),
    edges: z
      .array(
        z.object({
          id: z.string().min(1),
          source: z.string(),
          target: z.string(),
          sourceHandle: z.enum(['succeeded', 'failed']),
          targetHandle: z.literal('input')
        })
      )
      .max(200),
    viewport: z
      .object({ x: coordinate, y: coordinate, zoom: z.number().min(0.1).max(4) })
      .optional()
  })
  .superRefine((document, ctx) => {
    if (
      document.version === 1 &&
      document.nodes.some(
        (node) => hasWorkflowNodeLaunch(node.data.launch) || node.data.conversation
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['version'],
        message: 'Node launch settings require canvas version 2.'
      })
    }
    const nodes = new Map(document.nodes.map((node) => [node.id, node]))
    const ports = new Set<string>()
    const ids = new Set<string>()
    let valid = nodes.size === document.nodes.length
    for (const edge of document.edges) {
      const port = `${edge.source}:${edge.sourceHandle}`
      valid &&=
        nodes.get(edge.source)?.data.kind === 'agent' &&
        nodes.has(edge.target) &&
        !ports.has(port) &&
        !ids.has(edge.id)
      ports.add(port)
      ids.add(edge.id)
    }
    if (!valid) {
      ctx.addIssue({ code: 'custom', message: 'Invalid node identities or connections' })
    }
  })

export type WorkflowCanvasDocument = Omit<
  z.infer<typeof workflowCanvasDocumentSchema>,
  'nodes' | 'edges'
> & {
  nodes: WorkflowCanvasNode[]
  edges: WorkflowCanvasEdge[]
}

export function canvasWorkflowInput(document: WorkflowCanvasDocument): unknown {
  return {
    version: document.nodes.some(
      (node) => hasWorkflowNodeLaunch(node.data.launch) || node.data.conversation
    )
      ? 2
      : 1,
    name: document.name,
    entry: document.entry,
    maxSteps: document.maxSteps,
    nodes: document.nodes.map((node) => {
      if (node.data.kind === 'end') {
        return { id: node.id, type: 'end', outcome: node.data.outcome }
      }
      return {
        id: node.id,
        type: 'agent',
        agent: node.data.agent,
        prompt: node.data.prompt,
        ...(node.data.conversation ? { conversation: node.data.conversation } : {}),
        ...(hasWorkflowNodeLaunch(node.data.launch) ? { launch: node.data.launch } : {}),
        onSuccess:
          document.edges.find(
            (edge) => edge.source === node.id && edge.sourceHandle === 'succeeded'
          )?.target ?? '',
        onFailure:
          document.edges.find((edge) => edge.source === node.id && edge.sourceHandle === 'failed')
            ?.target ?? ''
      }
    })
  }
}

export function layoutWorkflowCanvas(document: WorkflowCanvasDocument): WorkflowCanvasDocument {
  const depths = new Map<string, number>([[document.entry, 0]])
  const pending = [document.entry]
  for (let index = 0; index < pending.length; index++) {
    const source = pending[index]
    for (const edge of document.edges.filter((candidate) => candidate.source === source)) {
      if (!depths.has(edge.target)) {
        depths.set(edge.target, (depths.get(source) ?? 0) + 1)
        pending.push(edge.target)
      }
    }
  }
  const rows = new Map<number, number>()
  return {
    ...document,
    viewport: undefined,
    nodes: document.nodes.map((node) => {
      const depth = depths.get(node.id) ?? 0
      const row = rows.get(depth) ?? 0
      rows.set(depth, row + 1)
      return { ...node, position: { x: depth * 360, y: row * 280 } }
    })
  }
}

export function workflowToCanvas(definition: WorkflowDefinition): WorkflowCanvasDocument {
  const nodes: WorkflowCanvasNode[] = definition.nodes.map((node) => ({
    id: node.id,
    type: 'workflow',
    position: { x: 0, y: 0 },
    data: {
      label: node.id,
      kind: node.type,
      agent: node.type === 'agent' ? node.agent : 'codex',
      prompt: node.type === 'agent' ? node.prompt : '',
      ...(node.type === 'agent' && node.conversation ? { conversation: node.conversation } : {}),
      ...(node.type === 'agent' && hasWorkflowNodeLaunch(node.launch)
        ? { launch: node.launch }
        : {}),
      outcome: node.type === 'end' ? node.outcome : 'succeeded'
    }
  }))
  const edges: WorkflowCanvasEdge[] = definition.nodes.flatMap((node) =>
    node.type === 'end'
      ? []
      : (['succeeded', 'failed'] as const).map((outcome) => ({
          id: `${node.id}:${outcome}`,
          source: node.id,
          target: outcome === 'succeeded' ? node.onSuccess : node.onFailure,
          sourceHandle: outcome,
          targetHandle: 'input'
        }))
  )
  return layoutWorkflowCanvas({
    format: 'orca-workflow-canvas',
    workflowId: createUuidV4(),
    version: definition.version,
    name: definition.name,
    entry: definition.entry,
    maxSteps: definition.maxSteps,
    nodes,
    edges
  })
}

export function createWorkflowCanvasTemplate(): WorkflowCanvasDocument {
  return workflowToCanvas(
    workflowDefinitionSchema.parse({
      version: 1,
      name: 'Development, test and repair',
      entry: 'develop',
      maxSteps: 8,
      nodes: [
        {
          id: 'develop',
          type: 'agent',
          agent: 'dsh',
          prompt:
            'Implement the task. On a repeated visit, repair the failures in the previous accepted test report. Include the code revision and checks in the handoff.',
          onSuccess: 'test',
          onFailure: 'failed'
        },
        {
          id: 'test',
          type: 'agent',
          agent: 'zcode',
          prompt:
            'Verify the handed-over revision and run the relevant checks. Report succeeded only when they pass. On failure, report the exact command, output and reproduction steps.',
          onSuccess: 'done',
          onFailure: 'develop'
        },
        { id: 'done', type: 'end', outcome: 'succeeded' },
        { id: 'failed', type: 'end', outcome: 'failed' }
      ]
    })
  )
}

export function connectWorkflowCanvas(
  document: WorkflowCanvasDocument,
  connection: Connection
): WorkflowCanvasDocument {
  if (
    !connection.source ||
    !connection.target ||
    !['succeeded', 'failed'].includes(connection.sourceHandle ?? '') ||
    connection.targetHandle !== 'input'
  ) {
    return document
  }
  const source = document.nodes.find((node) => node.id === connection.source)
  if (
    source?.data.kind !== 'agent' ||
    !document.nodes.some((node) => node.id === connection.target)
  ) {
    return document
  }
  return {
    ...document,
    edges: [
      ...document.edges.filter(
        (edge) => edge.source !== connection.source || edge.sourceHandle !== connection.sourceHandle
      ),
      {
        id: `${connection.source}:${connection.sourceHandle}`,
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle,
        targetHandle: 'input'
      }
    ]
  }
}

export function createWorkflowCanvasNode(
  kind: 'agent' | 'succeeded' | 'failed',
  position: { x: number; y: number }
): WorkflowCanvasNode {
  return {
    id: `node_${createUuidV4().replaceAll('-', '')}`,
    type: 'workflow',
    position,
    data: {
      label: kind === 'agent' ? 'Agent' : kind === 'succeeded' ? 'Complete' : 'Failed',
      kind: kind === 'agent' ? 'agent' : 'end',
      agent: 'codex',
      prompt: '',
      outcome: kind === 'failed' ? 'failed' : 'succeeded'
    }
  }
}

export function importWorkflowCanvas(value: unknown): WorkflowCanvasDocument {
  if (typeof value === 'object' && value !== null && 'format' in value) {
    const document = workflowCanvasDocumentSchema.parse(value)
    return { ...document, workflowId: document.workflowId ?? createUuidV4() }
  }
  return workflowToCanvas(workflowDefinitionSchema.parse(value))
}
