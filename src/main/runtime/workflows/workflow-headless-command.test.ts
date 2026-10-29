import { describe, expect, it } from 'vitest'
import {
  buildWorkflowHeadlessCommand,
  readWorkflowHeadlessReport
} from './workflow-headless-command'

describe('headless workflow CLI contract', () => {
  it.each(['dsh', 'zcode', 'codex'] as const)(
    'resumes %s using an explicit identity and refuses unscoped session defaults',
    (agent) => {
      const base = {
        agent,
        cwd: process.cwd(),
        spec: 'Current visit only',
        settings: { agentCmdOverrides: { [agent]: process.execPath }, agentDefaultArgs: {} },
        signal: new AbortController().signal
      }
      const command = buildWorkflowHeadlessCommand({
        ...base,
        resumeSessionId: '01800000-0000-4000-8000-000000000001'
      })
      expect(command.args).toContain('01800000-0000-4000-8000-000000000001')
      expect(command.timeoutMs).toBeNull()
      expect(command.args).toContain(
        agent === 'codex' ? 'resume' : agent === 'dsh' ? '--session-id' : '--resume'
      )
      if (agent === 'codex') {
        expect(command.args).not.toContain('--color')
      }
      expect(() => buildWorkflowHeadlessCommand({ ...base, resumeSessionId: '--last' })).toThrow()
      expect(() =>
        buildWorkflowHeadlessCommand({
          ...base,
          settings: {
            ...base.settings,
            agentDefaultArgs: {
              [agent]:
                agent === 'codex'
                  ? '--ephemeral'
                  : agent === 'dsh'
                    ? '--session-id shared'
                    : '--continue'
            }
          }
        })
      ).toThrow('Remove prompt')
    }
  )
  const report = { outcome: 'failed', body: 'node --test: one assertion failed', filesModified: [] }

  it.each(['dsh', 'zcode', 'codex'] as const)(
    'keeps all 22 modified files from the %s final report',
    (agent) => {
      const complete = {
        ...report,
        filesModified: Array.from({ length: 22 }, (_, index) => `src/file-${index}.js`)
      }
      const output =
        agent === 'dsh'
          ? JSON.stringify({ type: 'final', text: JSON.stringify(complete) })
          : agent === 'zcode'
            ? JSON.stringify({ response: JSON.stringify(complete) })
            : [
                JSON.stringify({
                  type: 'item.completed',
                  item: { type: 'agent_message', text: JSON.stringify(complete) }
                }),
                JSON.stringify({ type: 'turn.completed' })
              ].join('\n')
      expect(readWorkflowHeadlessReport(agent, output)).toEqual(complete)
    }
  )

  it('reads the final DSH event, without accepting an intermediate success or tool output', () => {
    const output = [
      'diagnostic',
      JSON.stringify({ type: 'text', text: JSON.stringify({ ...report, outcome: 'succeeded' }) }),
      JSON.stringify({ type: 'final', text: JSON.stringify(report) })
    ].join('\n')
    expect(readWorkflowHeadlessReport('dsh', output)).toEqual(report)
    expect(() =>
      readWorkflowHeadlessReport('dsh', output.split('\n').slice(0, 2).join('\n'))
    ).toThrow()
  })

  it('requires a structured ZCode business outcome rather than treating exit zero as success', () => {
    expect(
      readWorkflowHeadlessReport('zcode', JSON.stringify({ response: JSON.stringify(report) }))
    ).toEqual(report)
    expect(() =>
      readWorkflowHeadlessReport('zcode', JSON.stringify({ response: 'login required' }))
    ).toThrow()
    expect(() =>
      readWorkflowHeadlessReport(
        'zcode',
        JSON.stringify({
          response: JSON.stringify({
            ...report,
            outcome: 'blocked',
            body: 'permission client unavailable'
          })
        })
      )
    ).toThrow('needs attention')
  })

  it('accepts Codex final agent output only after the turn completes', () => {
    const message = (type: string, text: string) =>
      JSON.stringify({ type: 'item.completed', item: { type, text } })
    const final = message('agent_message', JSON.stringify(report))
    const completed = JSON.stringify({ type: 'turn.completed', usage: {} })
    expect(readWorkflowHeadlessReport('codex', [final, completed].join('\n'))).toEqual(report)
    expect(() => readWorkflowHeadlessReport('codex', final)).toThrow('did not complete')
    expect(() =>
      readWorkflowHeadlessReport(
        'codex',
        [message('command_execution', JSON.stringify(report)), completed].join('\n')
      )
    ).toThrow('final report')
    expect(() =>
      readWorkflowHeadlessReport(
        'codex',
        [final, JSON.stringify({ type: 'turn.failed' })].join('\n')
      )
    ).toThrow('execution failed')
    expect(() =>
      readWorkflowHeadlessReport(
        'codex',
        [final, completed, JSON.stringify({ type: 'turn.started' })].join('\n')
      )
    ).toThrow('did not complete')
    expect(() =>
      readWorkflowHeadlessReport(
        'codex',
        [
          message(
            'agent_message',
            JSON.stringify({ ...report, outcome: 'blocked', body: 'login required' })
          ),
          completed
        ].join('\n')
      )
    ).toThrow('needs attention: login required')
  })

  it('runs configured Codex via exec in folder workspaces and preserves permissions and environment', () => {
    const args = {
      agent: 'codex' as const,
      cwd: process.cwd(),
      spec: 'task\nwith a handoff',
      signal: new AbortController().signal,
      settings: {
        agentCmdOverrides: { codex: process.execPath },
        agentDefaultArgs: {
          codex: '--sandbox workspace-write --model old -c model_reasoning_effort=low'
        },
        agentDefaultEnv: { codex: { CODEX_HOME: 'configured-home' } }
      }
    }
    const inherited = buildWorkflowHeadlessCommand(args)
    expect(inherited.program).toBe(process.execPath)
    expect(inherited.cwd).toBe(process.cwd())
    expect(inherited.env?.CODEX_HOME).toBe('configured-home')
    expect(inherited.args).toEqual(
      expect.arrayContaining([
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
        'old',
        'model_reasoning_effort=low'
      ])
    )
    expect(inherited.args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(inherited.args?.at(-1)).toContain(JSON.stringify(args.spec))
    const overridden = buildWorkflowHeadlessCommand({
      ...args,
      launch: { model: 'selected', effort: 'high' }
    })
    expect(overridden.args).toEqual(
      expect.arrayContaining(['--model', 'selected', '--config', 'model_reasoning_effort="high"'])
    )
    expect(overridden.args).not.toContain('old')
    expect(overridden.args).not.toContain('model_reasoning_effort=low')
    expect(() =>
      buildWorkflowHeadlessCommand({
        ...args,
        settings: { ...args.settings, agentDefaultArgs: { codex: 'exec --json' } }
      })
    ).toThrow('Remove prompt')
  })

  it('uses the selected profile and provider environment without persisting credentials', () => {
    const command = buildWorkflowHeadlessCommand({
      agent: 'dsh',
      cwd: process.cwd(),
      spec: 'task',
      signal: new AbortController().signal,
      settings: {
        agentCmdOverrides: { dsh: process.execPath },
        agentDefaultArgs: {},
        agentDefaultEnv: {
          dsh: {
            ORCA_WORKFLOW_DSH_PROFILE: 'verified-profile',
            ORCA_AGENT_HOOK_TOKEN: 'parent-hook-token',
            ORCA_TERMINAL_HANDLE: 'parent-terminal',
            WORKBUDDY_AI_ELECTRON_BIN: 'client-path'
          }
        }
      }
    })
    expect(command.args).toEqual(
      expect.arrayContaining(['--profile', 'verified-profile', '--json'])
    )
    expect(command.env?.WORKBUDDY_AI_ELECTRON_BIN).toBe('client-path')
    expect(command.env?.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(command.env?.ORCA_BACKGROUND_LAUNCH).toBe('1')
    expect(command.env?.ORCA_AGENT_HOOK_TOKEN).toBeUndefined()
    expect(command.env?.ORCA_TERMINAL_HANDLE).toBeUndefined()
  })

  it('does not silently grant ZCode headless full access and preserves an explicit mode', () => {
    const args = {
      agent: 'zcode' as const,
      cwd: process.cwd(),
      spec: 'task',
      signal: new AbortController().signal
    }
    const settings = {
      agentCmdOverrides: { zcode: process.execPath },
      agentDefaultArgs: {},
      agentDefaultEnv: { zcode: { ORCA_WORKFLOW_ZCODE_MODE: 'build' } }
    }
    expect(buildWorkflowHeadlessCommand({ ...args, settings }).args).toEqual(
      expect.arrayContaining(['--mode', 'build'])
    )
    expect(
      buildWorkflowHeadlessCommand({
        ...args,
        settings: { ...settings, agentDefaultArgs: { zcode: '--mode yolo' } }
      }).args
    ).toEqual(expect.arrayContaining(['--mode', 'yolo']))
    expect(() =>
      buildWorkflowHeadlessCommand({
        ...args,
        settings: { ...settings, agentDefaultArgs: { zcode: '--prompt override' } }
      })
    ).toThrow('Remove prompt')
  })
})
