import { tokenizeCustomCommandTemplate } from '../../../shared/commit-message-prompt'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../../codex-cli/codex-read-only-app-server-args'
import { runCodexAppServerSession } from '../../codex/codex-app-server-session'
import { readCodexConfiguredLaunchDefaults } from '../../codex/codex-configured-launch-defaults'
import { codexStructuredLaunchArgs } from '../../codex/codex-structured-launch-args'
import { fetchCodexModelCatalogListing } from '../../codex/codex-structured-model-catalog'
import { resolveStructuredAgentCommand } from '../../native-chat/structured-agent-command-resolution'
import { nodeEnvironment } from './workflow-node-inventory'
import type { WorkflowHeadlessSettings } from './workflow-headless-command'
import type { WorkflowNodeOptions } from '../../../shared/workflow-node-launch'

export async function readWorkflowCodexModels(
  settings: WorkflowHeadlessSettings,
  cwd: string,
  signal?: AbortSignal
): Promise<Pick<WorkflowNodeOptions, 'models' | 'warnings'>> {
  const env = nodeEnvironment('codex', settings)
  const command = resolveStructuredAgentCommand('codex', settings, {
    pathEnv: env.PATH ?? env.Path
  })
  const parsed = tokenizeCustomCommandTemplate(settings.agentDefaultArgs?.codex ?? '', 'literal')
  if (!parsed.ok || parsed.spans.some((span) => span.divergesFromShell)) {
    throw new Error('Codex default arguments must be literal arguments.')
  }
  const args = codexStructuredLaunchArgs(parsed.tokens)
  for (let index = 0; index < parsed.tokens.length; index += 1) {
    const token = parsed.tokens[index]
    if (token === '--') {
      break
    }
    if (token === '-p' || token === '--profile') {
      args.push(token, parsed.tokens[++index])
    } else if (token.startsWith('--profile=') || /^-p.+/.test(token)) {
      args.push(token)
    }
  }
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      environment[key] = value
    }
  }
  return runCodexAppServerSession(
    {
      command,
      cliPath: command,
      args: [...args, ...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
      env: environment,
      cwd,
      signal,
      timeoutMs: 15_000
    },
    async (rpc) => {
      const listing = await fetchCodexModelCatalogListing({ connection: rpc, cwd }).catch(
        async () => ({
          models: [],
          complete: false,
          configured: (await readCodexConfiguredLaunchDefaults(rpc, undefined, cwd)) ?? undefined
        })
      )
      const models: WorkflowNodeOptions['models'] = listing.models.map((model) => ({
        id: model.id,
        label: model.label
      }))
      const configured = listing.configured?.model
      if (configured && !models.some((model) => model.id === configured)) {
        models.unshift({ id: configured, label: configured })
      }
      return {
        models,
        warnings:
          listing.complete === false
            ? ['Codex model discovery is incomplete. Configured models remain selectable.']
            : []
      }
    }
  )
}
