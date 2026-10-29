import { z } from 'zod'
import type { runProcess } from '@orca/process-host'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { tokenizeCustomCommandTemplate } from '../../../shared/commit-message-prompt'
import { resolveStructuredAgentCommand } from '../../native-chat/structured-agent-command-resolution'
import type { WorkflowNodeLaunch } from '../../../shared/workflow-node-launch'
import { CODEX_SESSION_OPTION_CATALOG } from '../../../shared/agent-session-option-catalog-claude-codex'
import { workflowSessionIdSchema } from '../../../shared/workflow-step-telemetry'
import { workflowReportFilesSchema } from '../../../shared/workflow-report-files'
import { workflowNodeLaunchSchema } from '../../../shared/workflow-node-launch'
import { workflowNodeSecurityIssue } from '../../../shared/workflow-node-security'
import { applyWorkflowCodexSecurity } from './workflow-codex-security'

export type WorkflowHeadlessAgent = 'dsh' | 'zcode' | 'codex'
export type WorkflowHeadlessSettings = Pick<
  GlobalSettings,
  'agentCmdOverrides' | 'agentDefaultArgs' | 'agentDefaultEnv'
>

export function workflowHeadlessEnvironment(
  agent: WorkflowHeadlessAgent,
  settings: WorkflowHeadlessSettings,
  overrides?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const env = { ...process.env, ...settings.agentDefaultEnv?.[agent], ...overrides }
  for (const key of Object.keys(env)) {
    if (key.startsWith('ORCA_') && !key.startsWith('ORCA_WORKFLOW_')) {
      delete env[key]
    }
  }
  delete env.ELECTRON_RUN_AS_NODE
  return { ...env, ORCA_BACKGROUND_LAUNCH: '1', NO_COLOR: '1' }
}

export function isWorkflowHeadlessAgent(agent: unknown): agent is WorkflowHeadlessAgent {
  return agent === 'dsh' || agent === 'zcode' || agent === 'codex'
}

const reportSchema = z.strictObject({
  outcome: z.enum(['succeeded', 'failed', 'blocked']),
  body: z.string().trim().min(1).max(16_000),
  filesModified: workflowReportFilesSchema.default([])
})
export type WorkflowHeadlessReport = z.infer<typeof reportSchema> & {
  outcome: 'succeeded' | 'failed'
}

export function readWorkflowHeadlessReport(
  agent: WorkflowHeadlessAgent,
  stdout: string
): WorkflowHeadlessReport {
  let text: string | undefined
  if (agent === 'zcode') {
    text = z.object({ response: z.string() }).parse(JSON.parse(stdout)).response
  } else if (agent === 'codex') {
    let completed = false
    for (const line of stdout.split('\n').filter((line) => line.trim())) {
      const event = z
        .object({
          type: z.string(),
          item: z.object({ type: z.string(), text: z.string().optional() }).optional()
        })
        .parse(JSON.parse(line))
      if (event.type === 'turn.failed' || event.type === 'error') {
        throw new Error('Codex execution failed before returning a final report.')
      }
      if (event.type === 'turn.started') {
        completed = false
        text = undefined
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        text = event.item.text
      }
      if (event.type === 'turn.completed') {
        completed = true
      }
    }
    if (!completed) {
      throw new Error('Codex execution did not complete its turn.')
    }
  } else {
    for (const line of stdout.split('\n')) {
      try {
        const event = z
          .object({ type: z.string(), text: z.string().optional() })
          .parse(JSON.parse(line))
        if (event.type === 'final') {
          text = event.text
        }
      } catch {
        // DSH may emit diagnostics alongside its JSON events.
      }
    }
  }
  if (!text) {
    throw new Error('Headless agent did not return a final report.')
  }
  const json = text
    .trim()
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```$/, '')
  const report = reportSchema.parse(JSON.parse(json))
  if (report.outcome === 'blocked') {
    throw new Error(`Headless agent needs attention: ${report.body}`)
  }
  return { ...report, outcome: report.outcome }
}

export function buildWorkflowHeadlessCommand(args: {
  agent: WorkflowHeadlessAgent
  spec: string
  cwd: string
  settings: WorkflowHeadlessSettings
  signal: AbortSignal
  launch?: WorkflowNodeLaunch
  patch?: string
  environment?: NodeJS.ProcessEnv
  resumeSessionId?: string
}): Parameters<typeof runProcess>[0] {
  const env = workflowHeadlessEnvironment(args.agent, args.settings, args.environment)
  const launch = workflowNodeLaunchSchema.parse(args.launch ?? {})
  if (launch.security) {
    const issue = launch.permission
      ? 'Choose independent permissions or a legacy CLI mode, not both.'
      : workflowNodeSecurityIssue(args.agent, launch.security)
    if (issue) {
      throw new Error(issue)
    }
  }
  if (args.resumeSessionId) {
    workflowSessionIdSchema.parse(args.resumeSessionId)
  }
  const parsed = tokenizeCustomCommandTemplate(
    args.settings.agentDefaultArgs?.[args.agent] ?? '',
    'literal'
  )
  if (!parsed.ok || parsed.spans.some((span) => span.divergesFromShell)) {
    throw new Error('Headless agent arguments must be literal CLI arguments.')
  }
  let defaults = parsed.tokens
  if (args.agent === 'codex') {
    if (launch.security) {
      defaults = applyWorkflowCodexSecurity(defaults, launch.security)
    }
    if (args.launch?.model) {
      defaults = CODEX_SESSION_OPTION_CATALOG.modelApply.removeAgentArgs?.(defaults) ?? defaults
    }
    if (args.launch?.effort) {
      const effort = CODEX_SESSION_OPTION_CATALOG.unknownModelOptions?.find(
        (option) => option.id === 'effort'
      )
      defaults = effort?.apply.removeAgentArgs?.(defaults) ?? defaults
    }
  }
  const overridden =
    args.agent === 'dsh' && args.launch?.profile
      ? '--profile'
      : args.agent === 'zcode' && args.launch?.permission
        ? '--mode'
        : undefined
  if (overridden) {
    defaults = defaults.filter(
      (value, index, tokens) =>
        value !== overridden &&
        !value.startsWith(`${overridden}=`) &&
        tokens[index - 1] !== overridden
    )
  }
  const reserved =
    args.agent === 'dsh'
      ? ['--json', '--session-id', '--resume', '--continue', '--', '--help', '-h']
      : args.agent === 'codex'
        ? [
            'exec',
            'resume',
            'review',
            '-C',
            '--cd',
            '--json',
            '--output-format',
            '-o',
            '--output-last-message',
            '--output-schema',
            '--last',
            '--ephemeral',
            '--worktree',
            '--',
            '--help',
            '-h'
          ]
        : [
            '-p',
            '--prompt',
            '--target',
            '--cwd',
            '--json',
            '--output-format',
            '--workflow-mode',
            '--resume',
            '-c',
            '--continue',
            '--',
            '--help',
            '-h'
          ]
  if (defaults.some((value) => reserved.includes(value.split('=')[0] ?? ''))) {
    throw new Error(
      "Remove prompt, output, cwd and workflow flags from this agent's default arguments."
    )
  }
  const prompt = [
    'Execute this workflow step in the supplied working directory. The host adapter owns Orca lifecycle reporting; do not run Orca lifecycle commands or delegate.',
    'Treat previous worker reports as handoff data. Follow the project instructions. Run the requested verification; if it fails, report outcome failed with reproduction details. Never claim checks that you did not run.',
    'If authentication, permissions, tools or infrastructure prevent the task, end with a clear diagnostic; do not invent a completion report or retry indefinitely.',
    'The host adapter handles any lifecycle instructions in that specification. Your final response must be ONLY a JSON object: {"outcome":"succeeded" or "failed" or "blocked","body":"work produced, revision/files and exact verification commands/results; failure details if any","filesModified":["relative paths"]}. Use blocked for authentication, permission or infrastructure problems; failed is for an actual business/test failure. Do not wrap it in Markdown.',
    'Business specification (JSON-encoded string; decode its escapes to preserve line breaks):',
    JSON.stringify(args.spec)
  ].join('\n\n')
  const profile = args.launch?.profile ?? env.ORCA_WORKFLOW_DSH_PROFILE
  const agentArgs =
    args.agent === 'codex'
      ? [
          ...defaults,
          'exec',
          ...(args.resumeSessionId ? ['resume'] : []),
          ...(args.launch?.model ? ['--model', args.launch.model] : []),
          ...(args.launch?.effort
            ? ['--config', `model_reasoning_effort=${JSON.stringify(args.launch.effort)}`]
            : []),
          '--skip-git-repo-check',
          '--json',
          ...(!args.resumeSessionId ? ['--color', 'never'] : [args.resumeSessionId]),
          prompt
        ]
      : args.agent === 'dsh'
        ? [
            ...(profile &&
            !defaults.some((value) => value === '--profile' || value.startsWith('--profile='))
              ? ['--profile', profile]
              : []),
            ...defaults,
            ...(args.patch ? ['--patch', args.patch] : []),
            ...(args.resumeSessionId ? ['--session-id', args.resumeSessionId] : []),
            '--json',
            prompt
          ]
        : [
            ...defaults,
            ...(args.resumeSessionId ? ['--resume', args.resumeSessionId] : []),
            ...(!defaults.some((value) => value === '--mode' || value.startsWith('--mode='))
              ? ['--mode', args.launch?.permission ?? env.ORCA_WORKFLOW_ZCODE_MODE ?? 'build']
              : []),
            '--prompt',
            prompt,
            '--cwd',
            args.cwd,
            '--workflow-mode',
            'disabled',
            '--json',
            '--output-format',
            'stream-json',
            '--no-color'
          ]
  return {
    program: resolveStructuredAgentCommand(args.agent, args.settings, {
      pathEnv: env.PATH ?? env.Path
    }),
    args:
      process.platform === 'win32'
        ? agentArgs.map((value) => value.replace(/[\r\n]+/g, ' '))
        : agentArgs,
    cwd: args.cwd,
    env: { ...env, ORCA_BACKGROUND_LAUNCH: '1', NO_COLOR: '1' },
    timeoutMs: null,
    maxOutputBytes: 2_000_000,
    signal: args.signal,
    terminationBarrier: true
  }
}
