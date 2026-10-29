import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { workflowDefinitionSchema, withWorkflowConversationDefaults } from './workflow-definition'

function repairWorkflow() {
  const input: unknown = JSON.parse(
    readFileSync(
      resolve(__dirname, '../../examples/workflows/development-test-repair.json'),
      'utf8'
    )
  )
  return workflowDefinitionSchema.parse(input)
}

function issuesFor(input: unknown) {
  const parsed = workflowDefinitionSchema.safeParse(input)
  expect(parsed.success).toBe(false)
  return parsed.success ? [] : parsed.error.issues
}

describe('workflow definitions', () => {
  it('makes omitted conversation choices explicit for host admission without changing node routing', () => {
    const original = repairWorkflow()
    const explicit = withWorkflowConversationDefaults(original)
    expect(explicit.version).toBe(2)
    expect(explicit.nodes).toEqual(
      original.nodes.map((node) =>
        node.type === 'agent' ? { ...node, conversation: { mode: 'latest' } } : node
      )
    )
    expect(withWorkflowConversationDefaults(explicit)).toEqual(explicit)
    expect(original.version).toBe(1)
    expect(original.nodes[0]).not.toHaveProperty('conversation')
  })
  it('requires version 2 for explicit node settings and refuses unsupported overrides', () => {
    const original = repairWorkflow()
    const nodes = original.nodes.map((node) =>
      node.id === 'develop'
        ? {
            ...node,
            launch: {
              model: 'deepseek-test',
              effort: 'high',
              permission: 'workspace-write',
              plugins: ['provider'],
              skills: ['skill-id'],
              mcpServers: ['mcp-id']
            }
          }
        : node
    )
    expect(issuesFor({ ...original, nodes })).toContainEqual(
      expect.objectContaining({ path: ['version'] })
    )
    expect(
      workflowDefinitionSchema.parse({ ...original, version: 2, nodes }).nodes[0]
    ).toHaveProperty('launch.permission', 'workspace-write')
    expect(() =>
      workflowDefinitionSchema.parse({
        ...original,
        version: 2,
        nodes: nodes.map((node) =>
          node.type === 'agent'
            ? { ...node, launch: { permission: 'automatic-full-access' } }
            : node
        )
      })
    ).toThrow('permission mode')
    expect(() =>
      workflowDefinitionSchema.parse({
        ...original,
        version: 2,
        nodes: nodes.map((node) =>
          node.type === 'agent'
            ? { ...node, agent: 'codex', launch: { plugins: ['plugin'] } }
            : node
        )
      })
    ).toThrow('DSH or ZCode')
  })
  it('accepts the DSH development and ZCode testing example with a bounded repair loop', () => {
    const definition = repairWorkflow()
    expect(definition.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'develop', agent: 'dsh', onSuccess: 'test' }),
        expect.objectContaining({ id: 'test', agent: 'zcode', onFailure: 'develop' })
      ])
    )
    expect(definition.maxSteps).toBe(8)
  })

  it('rejects duplicate IDs before interpreting ambiguous edges', () => {
    const definition = repairWorkflow()
    const issues = issuesFor({
      ...definition,
      nodes: [...definition.nodes, { id: 'develop', type: 'end', outcome: 'failed' }]
    })
    expect(issues).toEqual([
      expect.objectContaining({ path: ['nodes', 4, 'id'], message: 'Duplicate node ID: develop' })
    ])
  })

  it('rejects an entry that does not name a node', () => {
    expect(issuesFor({ ...repairWorkflow(), entry: 'missing' })).toContainEqual(
      expect.objectContaining({ path: ['entry'], message: 'Entry node does not exist' })
    )
  })

  it.each(['onSuccess', 'onFailure'] as const)('rejects a missing %s destination', (field) => {
    const definition = repairWorkflow()
    expect(
      issuesFor({
        ...definition,
        nodes: definition.nodes.map((node) =>
          node.id === 'develop' ? { ...node, [field]: 'missing' } : node
        )
      })
    ).toContainEqual(
      expect.objectContaining({
        path: ['nodes', 0, field],
        message: 'Target node does not exist: missing'
      })
    )
  })

  it('reports disconnected nodes', () => {
    const definition = repairWorkflow()
    expect(
      issuesFor({
        ...definition,
        nodes: [...definition.nodes, { id: 'unused', type: 'end', outcome: 'succeeded' }]
      })
    ).toContainEqual(
      expect.objectContaining({
        path: ['nodes', 4, 'id'],
        message: 'Node is unreachable from the entry: unused'
      })
    )
  })

  it('rejects a closed cycle even when another component has an end node', () => {
    const definition = repairWorkflow()
    expect(
      issuesFor({
        ...definition,
        nodes: definition.nodes.map((node) =>
          node.type === 'agent' ? { ...node, onSuccess: 'develop', onFailure: 'test' } : node
        )
      })
    ).toContainEqual(expect.objectContaining({ message: 'Node has no path to an end: develop' }))
  })

  it('requires an explicit end node', () => {
    const definition = repairWorkflow()
    expect(
      issuesFor({
        ...definition,
        nodes: definition.nodes
          .filter((node) => node.type === 'agent')
          .map((node) => ({ ...node, onSuccess: 'test', onFailure: 'develop' }))
      })
    ).toContainEqual(expect.objectContaining({ message: 'Add at least one end node' }))
  })

  it.each([undefined, 0, -1, 1.5, 1001, Infinity])(
    'rejects an invalid step budget: %s',
    (maxSteps) => {
      expect(issuesFor({ ...repairWorkflow(), maxSteps })).toContainEqual(
        expect.objectContaining({ path: ['maxSteps'] })
      )
    }
  )

  it('rejects an unknown agent instead of silently selecting a default', () => {
    const definition = repairWorkflow()
    expect(
      issuesFor({
        ...definition,
        nodes: definition.nodes.map((node) =>
          node.id === 'develop' ? { ...node, agent: 'not-an-orca-agent' } : node
        )
      })
    ).toContainEqual(expect.objectContaining({ path: ['nodes', 0, 'agent'] }))
  })

  it('rejects unsupported schema versions and fields instead of dropping behavior', () => {
    expect(issuesFor({ ...repairWorkflow(), version: 3 })).toContainEqual(
      expect.objectContaining({ path: ['version'] })
    )
    expect(issuesFor({ ...repairWorkflow(), concurrency: 4 })).toContainEqual(
      expect.objectContaining({ code: 'unrecognized_keys' })
    )
  })

  it('rejects a blank agent prompt and preserves meaningful prompt whitespace', () => {
    const definition = repairWorkflow()
    expect(
      issuesFor({
        ...definition,
        nodes: definition.nodes.map((node) =>
          node.id === 'develop' ? { ...node, prompt: ' \n\t' } : node
        )
      })
    ).toContainEqual(expect.objectContaining({ path: ['nodes', 0, 'prompt'] }))
    const parsed = workflowDefinitionSchema.parse({
      ...definition,
      nodes: definition.nodes.map((node) =>
        node.id === 'develop' ? { ...node, prompt: '  preserve indentation\n' } : node
      )
    })
    expect(parsed.nodes[0]).toMatchObject({ prompt: '  preserve indentation\n' })
  })

  it('limits graph size before traversing untrusted definitions', () => {
    expect(
      issuesFor({
        ...repairWorkflow(),
        nodes: Array.from({ length: 101 }, (_, index) => ({
          id: `end${index}`,
          type: 'end',
          outcome: 'succeeded'
        }))
      })
    ).toContainEqual(expect.objectContaining({ path: ['nodes'], code: 'too_big' }))
  })
})
