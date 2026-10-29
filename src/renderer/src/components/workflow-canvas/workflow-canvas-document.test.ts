import { describe, expect, it } from 'vitest'
import { workflowDefinitionSchema } from '../../../../shared/workflow-definition'
import {
  canvasWorkflowInput,
  connectWorkflowCanvas,
  createWorkflowCanvasNode,
  createWorkflowCanvasTemplate,
  importWorkflowCanvas,
  layoutWorkflowCanvas,
  workflowCanvasDocumentSchema,
  workflowToCanvas
} from './workflow-canvas-document'

describe('workflow canvas execution boundary', () => {
  it('preserves per-node launch settings across imports without changing adjacent nodes', () => {
    const document = createWorkflowCanvasTemplate()
    document.version = 2
    document.nodes[0].data.launch = {
      model: 'test-model',
      effort: 'high',
      permission: 'workspace-write',
      plugins: ['plugin'],
      mcpServers: ['mcp'],
      skills: ['skill'],
      profile: 'test-profile'
    }
    const definition = workflowDefinitionSchema.parse(
      canvasWorkflowInput(importWorkflowCanvas(JSON.parse(JSON.stringify(document))))
    )
    expect(definition.version).toBe(2)
    expect(workflowToCanvas(definition).nodes[0].data.launch).toEqual(document.nodes[0].data.launch)
    expect(definition.nodes[1]).not.toHaveProperty('launch')
    expect(() => importWorkflowCanvas({ ...document, version: 1 })).toThrow('version 2')
  })
  it('round trips the development, test and rework cycle through the strict executor schema', () => {
    const document = createWorkflowCanvasTemplate()
    const definition = workflowDefinitionSchema.parse(canvasWorkflowInput(document))
    expect(definition.nodes.find((node) => node.id === 'test')).toMatchObject({
      agent: 'zcode',
      onFailure: 'develop'
    })
    expect(canvasWorkflowInput(workflowToCanvas(definition))).toEqual(definition)
    expect(definition.nodes[0]).not.toHaveProperty('position')
    expect(definition.nodes[0]).not.toHaveProperty('data')
  })

  it('preserves layout and viewport while discarding renderer measurement and selection state', () => {
    const document = createWorkflowCanvasTemplate()
    document.nodes[0] = {
      ...document.nodes[0],
      selected: true,
      measured: { width: 256, height: 230 },
      position: { x: -50, y: 180 }
    }
    document.viewport = { x: 100, y: -90, zoom: 0.7 }
    const imported = importWorkflowCanvas(JSON.parse(JSON.stringify(document)))
    expect(imported.nodes[0].position).toEqual({ x: -50, y: 180 })
    expect(imported.viewport).toEqual(document.viewport)
    expect(imported.nodes[0]).not.toHaveProperty('selected')
    expect(imported.nodes[0]).not.toHaveProperty('measured')
  })

  it('replaces a single output connection while preserving the other branch', () => {
    const document = createWorkflowCanvasTemplate()
    const connected = connectWorkflowCanvas(document, {
      source: 'develop',
      sourceHandle: 'succeeded',
      target: 'done',
      targetHandle: 'input'
    })
    expect(connected.edges).toHaveLength(4)
    expect(connected.edges.find((edge) => edge.id === 'develop:succeeded')?.target).toBe('done')
    expect(connected.edges.find((edge) => edge.id === 'develop:failed')?.target).toBe('failed')
  })

  it('rejects unknown handles, dangling connections, and outputs from end nodes', () => {
    const document = createWorkflowCanvasTemplate()
    for (const connection of [
      { source: 'develop', sourceHandle: 'wrong', target: 'done', targetHandle: 'input' },
      { source: 'done', sourceHandle: 'succeeded', target: 'develop', targetHandle: 'input' },
      { source: 'develop', sourceHandle: 'failed', target: 'missing', targetHandle: 'input' }
    ]) {
      expect(connectWorkflowCanvas(document, connection)).toBe(document)
    }
  })

  it('keeps incomplete drafts but blocks execution export', () => {
    const document = createWorkflowCanvasTemplate()
    document.nodes.push(createWorkflowCanvasNode('agent', { x: 10, y: 20 }))
    expect(workflowCanvasDocumentSchema.safeParse(document).success).toBe(true)
    expect(workflowDefinitionSchema.safeParse(canvasWorkflowInput(document)).success).toBe(false)
    expect(importWorkflowCanvas(document).nodes).toHaveLength(5)
  })

  it('rejects malformed imports without coercing a canvas into executable input', () => {
    const document = createWorkflowCanvasTemplate()
    expect(() => importWorkflowCanvas({ ...document, version: 3 })).toThrow()
    expect(() =>
      importWorkflowCanvas({ ...document, nodes: [document.nodes[0], document.nodes[0]] })
    ).toThrow()
    expect(() =>
      importWorkflowCanvas({ ...document, edges: [...document.edges, document.edges[0]] })
    ).toThrow()
    expect(() =>
      importWorkflowCanvas({
        ...document,
        nodes: [{ ...document.nodes[0], position: { x: Infinity, y: 0 } }]
      })
    ).toThrow()
  })

  it('imports plain executor JSON and arranges cyclic graphs without looping', () => {
    const document = createWorkflowCanvasTemplate()
    const imported = importWorkflowCanvas(canvasWorkflowInput(document))
    expect(imported.nodes).toHaveLength(4)
    expect(layoutWorkflowCanvas(imported).nodes.map((node) => node.position)).toEqual(
      imported.nodes.map((node) => node.position)
    )
    expect(
      new Set(imported.nodes.map((node) => `${node.position.x}:${node.position.y}`)).size
    ).toBe(4)
  })
})
