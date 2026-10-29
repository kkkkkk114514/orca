import { expect, it } from 'vitest'
import { buildWorkflowHeadlessCommand } from './workflow-headless-command'

const args = {
  agent: 'codex' as const,
  cwd: process.cwd(),
  spec: 'Verify permissions',
  signal: new AbortController().signal,
  settings: {
    agentCmdOverrides: { codex: process.execPath },
    agentDefaultEnv: {},
    agentDefaultArgs: {
      codex:
        '--dangerously-bypass-approvals-and-sandbox --approve-for-me -s danger-full-access --add-dir /old -c sandbox_workspace_write.writable_roots=["/old"] --config=approval_policy="on-request" --disable network_proxy --disable=network_proxy --model keep'
    }
  }
}

it('overrides conflicting defaults, enables proxy enforcement and preserves unrelated CLI arguments and settings', () => {
  const command = buildWorkflowHeadlessCommand({
    ...args,
    launch: {
      security: {
        access: 'workspace-write',
        approval: 'never',
        network: 'restricted',
        writableDirectories: [process.cwd()],
        allowedHosts: ['registry.npmjs.org']
      }
    }
  })
  expect(command.args).toEqual(
    expect.arrayContaining([
      '--sandbox',
      'workspace-write',
      'approval_policy="never"',
      'approvals_reviewer="user"',
      'sandbox_workspace_write.network_access=true',
      'features.network_proxy={ enabled = true, domains = { "registry.npmjs.org" = "allow" } }',
      `sandbox_workspace_write.writable_roots=${JSON.stringify([process.cwd()])}`,
      '--model',
      'keep'
    ])
  )
  expect(command.args?.join(' ')).not.toMatch(
    /dangerously-bypass|approve-for-me|danger-full-access|\/old|--disable/
  )
  expect(args.settings.agentDefaultArgs.codex).toContain('--disable network_proxy')
  const resumed = buildWorkflowHeadlessCommand({
    ...args,
    resumeSessionId: '01999999-1234-7000-8000-123456789abc',
    launch: { security: { access: 'read-only', approval: 'never' } }
  })
  expect(resumed.args).toEqual(
    expect.arrayContaining(['resume', '--sandbox', 'read-only', 'approval_policy="never"'])
  )
})

it('does not silently widen scope for unsupported policies or relative writable directories', () => {
  expect(() =>
    buildWorkflowHeadlessCommand({
      ...args,
      launch: { security: { access: 'workspace-write', writableDirectories: ['../outside'] } }
    })
  ).toThrow('absolute paths')
  expect(() =>
    buildWorkflowHeadlessCommand({
      ...args,
      agent: 'zcode',
      launch: { security: { access: 'read-only' } }
    })
  ).toThrow('does not support')
  const denied = buildWorkflowHeadlessCommand({
    ...args,
    launch: { security: { access: 'workspace-write', network: 'deny' } }
  })
  expect(denied.args).toEqual(
    expect.arrayContaining([
      'sandbox_workspace_write.network_access=false',
      'features.network_proxy=false'
    ])
  )
  const inherited = buildWorkflowHeadlessCommand({ ...args })
  expect(inherited.args).toContain('--dangerously-bypass-approvals-and-sandbox')
})
