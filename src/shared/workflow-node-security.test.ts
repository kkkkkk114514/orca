import { expect, it } from 'vitest'
import { workflowNodeSecuritySchema } from './workflow-node-security'
import { workflowDefinitionSchema } from './workflow-definition'

const definition = (agent: string, launch: unknown) => ({
  version: 2,
  name: 'Permissions',
  entry: 'work',
  maxSteps: 2,
  nodes: [
    {
      id: 'work',
      type: 'agent',
      agent,
      launch,
      prompt: 'Work',
      onSuccess: 'done',
      onFailure: 'done'
    },
    { id: 'done', type: 'end', outcome: 'succeeded' }
  ]
})

it('accepts independent Codex policies and retains them through validated workflow serialization', () => {
  const launch = {
    security: {
      access: 'workspace-write',
      approval: 'never',
      network: 'restricted',
      writableDirectories: ['/cache'],
      allowedHosts: ['REGISTRY.NPMJS.ORG', '*.example.com']
    }
  }
  const parsed = workflowDefinitionSchema.parse(definition('codex', launch))
  expect(parsed.nodes[0]).toMatchObject({
    launch: {
      security: { ...launch.security, allowedHosts: ['registry.npmjs.org', '*.example.com'] }
    }
  })
  expect(workflowDefinitionSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
  expect(
    workflowDefinitionSchema.safeParse(
      definition('dsh', { security: { access: 'read-only', approval: 'never' } })
    ).success
  ).toBe(true)
})

it('rejects unsupported, conflicting, empty allowlist and ineffective restrictions instead of dropping them', () => {
  for (const invalid of [
    definition('zcode', { security: { access: 'read-only' } }),
    definition('dsh', { security: { access: 'workspace-write', network: 'deny' } }),
    definition('dsh', { security: { access: 'workspace-write', writableDirectories: ['/cache'] } }),
    definition('dsh', { permission: 'workspace-write', security: { approval: 'never' } }),
    definition('codex', { security: { access: 'full-access', network: 'deny' } }),
    definition('codex', {
      security: { access: 'workspace-write', network: 'restricted', allowedHosts: [] }
    })
  ]) {
    expect(workflowDefinitionSchema.safeParse(invalid).success).toBe(false)
  }
  for (const hostname of [
    '*',
    'https://example.com',
    'example.com:443',
    'a..com',
    '-a.com',
    'a.com/path'
  ]) {
    expect(
      workflowNodeSecuritySchema.safeParse({
        access: 'workspace-write',
        network: 'restricted',
        allowedHosts: [hostname]
      }).success
    ).toBe(false)
  }
  expect(
    workflowDefinitionSchema.safeParse(definition('zcode', { permission: 'guarded' })).success
  ).toBe(true)
  expect(
    workflowDefinitionSchema.safeParse(definition('dsh', { permission: 'workspace-write' })).success
  ).toBe(true)
})
