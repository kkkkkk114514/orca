import { workflowSessionConfiguration } from './workflow-session-configuration'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { WorkerStartParams } from '../../../shared/rpc-contract/orchestration-worker-start-params'
import type { OrcaRuntimeService } from '../orca-runtime'
import {
  buildWorkflowHeadlessCommand,
  type WorkflowHeadlessAgent
} from './workflow-headless-command'
import { prepareWorkflowNodeSettings } from './workflow-node-settings'
import { verifyCodexNetworkPolicy } from './workflow-security-capabilities'

export function isWorkflowHeadlessWorkerStartOptions(value: unknown) {
  return z.object({ execution: z.literal('workflow_headless') }).safeParse(value).success
}

export async function prepareWorkflowHeadlessWorkerLaunch(args: {
  runtime: OrcaRuntimeService
  workspace: { id: string; path: string; connectionId: string | null }
  params: z.infer<typeof WorkerStartParams>
  agent: WorkflowHeadlessAgent
  spec: string
  root: string
  signal: AbortSignal
}) {
  const { runtime, workspace, params, agent } = args
  if (workspace.connectionId !== null) {
    throw new Error(
      'Headless workers must run on the workspace owning host. Connect to that host runtime.'
    )
  }
  const projectRuntime = runtime.resolveProjectRuntimeForWorktree(workspace.id)
  if (
    projectRuntime?.status === 'repair-required' ||
    (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl')
  ) {
    throw new Error(
      'Canvas headless workers require a native workspace on its owning host. WSL node execution is not supported yet.'
    )
  }
  const settings = runtime.getClientSettings()
  if (settings.disabledTuiAgents.includes(agent)) {
    throw new Error(`The ${agent} agent is disabled.`)
  }
  const launch =
    params.workflowLaunch ??
    (params.model || params.effort ? { model: params.model, effort: params.effort } : undefined)
  if (
    agent === 'codex' &&
    (launch?.permission ||
      launch?.profile ||
      launch?.provider ||
      launch?.plugins?.length ||
      launch?.mcpServers?.length)
  ) {
    throw new Error(
      'Codex workflow nodes support model, effort and Skills overrides only; other settings are inherited from the configured CLI.'
    )
  }
  let spec = args.spec
  const skillFiles: string[] = []
  if (launch?.skills?.length) {
    const { discoverWorkflowNodeSkills } = await import('./workflow-node-options')
    const discovered = await discoverWorkflowNodeSkills(runtime, workspace)
    const paths = launch.skills.map((id) => {
      const skill = discovered.skills.find((item) => item.id === id && item.installed)
      if (!skill) {
        throw new Error(`Selected Skill is no longer installed on this host: ${id}`)
      }
      skillFiles.push(skill.skillFilePath)
      return JSON.stringify({ name: skill.name, file: skill.skillFilePath })
    })
    spec += `\n\nUser-selected Skills for this node: read these SKILL.md files and follow their applicable instructions before starting.\n${paths.join('\n')}`
  }
  const prepared =
    agent === 'codex'
      ? { environment: {}, patch: undefined, cleanup: async () => {} }
      : await prepareWorkflowNodeSettings({
          agent,
          settings,
          cwd: workspace.path,
          root: args.root,
          launch,
          signal: args.signal
        })
  try {
    if (agent === 'codex' && launch?.security?.network === 'restricted') {
      await verifyCodexNetworkPolicy(settings, workspace.path, launch.security, args.signal)
    }
    const commandOptions = {
      agent,
      spec,
      cwd: workspace.path,
      settings,
      signal: args.signal,
      launch,
      patch: prepared.patch,
      environment: prepared.environment
    }
    const command = buildWorkflowHeadlessCommand(commandOptions)
    const configurationKey = createHash('sha256')
      .update(
        JSON.stringify({
          agent,
          cliConfiguration: await workflowSessionConfiguration({
            agent,
            settings,
            cwd: workspace.path,
            program: command.program,
            launch,
            skills: skillFiles
          }),
          program: command.program,
          cwd: workspace.path,
          defaults: settings.agentDefaultArgs?.[agent],
          environment: Object.entries(settings.agentDefaultEnv?.[agent] ?? {}).sort(([a], [b]) =>
            a.localeCompare(b)
          ),
          profile: command.env?.ORCA_WORKFLOW_DSH_PROFILE,
          launch
        })
      )
      .digest('hex')
    return {
      launch,
      configurationKey,
      invocationCommand: (
        sessionId?: string,
        artifacts?: string,
        crossRun = false,
        codexHome?: string | null,
        supplement?: string
      ) => {
        const prompt = supplement
          ? `${spec}\n\n${supplement}`
          : sessionId && !crossRun
            ? (params.workflowContext?.continuation ?? spec)
            : spec
        return buildWorkflowHeadlessCommand({
          ...commandOptions,
          spec: artifacts
            ? `${prompt}\n\nOptional attachment destination for this visit: ${JSON.stringify(artifacts)}. When your existing permissions allow it, put requested logs or screenshots there and list their paths in the report. If unavailable, keep artifacts in the authorized workspace and list those paths instead; do not fail solely for attachment placement or request broader permissions. Orca generates report.json and report.md; do not edit them.`
            : prompt,
          resumeSessionId: sessionId,
          environment: {
            ...prepared.environment,
            ...(codexHome !== undefined && agent === 'codex'
              ? { CODEX_HOME: codexHome ?? undefined }
              : {}),
            ...(artifacts ? { ORCA_WORKFLOW_ARTIFACTS_DIRECTORY: artifacts } : {})
          }
        })
      },
      cleanup: prepared.cleanup
    }
  } catch (error) {
    await prepared.cleanup()
    throw error
  }
}
