import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { z } from 'zod'
import { workflowDefinitionSchema } from '../../shared/workflow-definition'
import { advanceWorkflow, createWorkflowExecution } from '../../shared/workflow-executor'
import { readInjectedAgentSessionId } from '../../shared/agent-session-caller-env'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { WorkflowExecution } from '../../shared/workflow-execution'
import type { HandlerContext } from '../dispatch'
import { getOptionalPositiveIntegerFlag, getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime/types'
import { getRequiredWorktreeSelector } from '../selectors'
import { withWorkflowCheckpoint } from '../workflow-checkpoint'
import { createWorkflowRuntime } from '../workflow-runtime'
import { resolveCoordinatorTerminalHandle } from './orchestration/terminal-identity'

export function printWorkflowExecution(
  state: WorkflowExecution,
  path: string,
  json: boolean,
  waiting: string | null = null
): void {
  const currentStep = state.steps.at(-1)
  const summary = {
    stateFile: path,
    status: state.status,
    runId: state.runId ?? null,
    node: state.cursor,
    steps: state.steps.length,
    maxSteps: state.definition.maxSteps,
    reason: state.reason ?? null,
    waiting,
    activeDispatch: currentStep && !currentStep.released ? (currentStep.dispatchId ?? null) : null
  }
  console.log(
    json
      ? JSON.stringify(summary, null, 2)
      : `Workflow ${state.definition.name}: ${state.status}; ${summary.steps}/${summary.maxSteps} steps; node ${state.cursor}\nCheckpoint: ${path}${waiting ? `\n${waiting}` : ''}`
  )
}

export async function runWorkflow(ctx: HandlerContext, definitionInput?: unknown): Promise<void> {
  const { flags, client, cwd, json } = ctx
  const definition =
    definitionInput === undefined ? undefined : workflowDefinitionSchema.parse(definitionInput)
  const path = resolve(cwd, getRequiredStringFlag(flags, 'state'))
  const input = definition ? getRequiredStringFlag(flags, 'input') : undefined
  if (input && input.length > 64_000) {
    throw new RuntimeClientError('invalid_argument', 'Workflow input exceeds 64000 characters.')
  }
  const timeoutMs = getOptionalPositiveIntegerFlag(flags, 'timeout-ms') ?? 30_000
  if (timeoutMs > 86_400_000) {
    throw new RuntimeClientError('invalid_argument', '--timeout-ms must not exceed one day.')
  }
  const deadline = Date.now() + timeoutMs
  const status = await client.call<RuntimeStatus>('status.get')
  const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
  const sessionId = readInjectedAgentSessionId()
  const target = createHash('sha256')
    .update(
      JSON.stringify({
        userDataPath: client.userDataPath,
        environment: client.environmentSelector,
        remote: client.isRemote,
        installationId: status.result.hostDescriptor?.installationId,
        machineBinding: status.result.hostDescriptor?.machineBinding,
        pairedDeviceId: status.result.pairedDeviceId
      })
    )
    .digest('hex')
  try {
    await withWorkflowCheckpoint(path, Boolean(definition), async (store) => {
      let state: WorkflowExecution
      if (definition && input !== undefined) {
        const selected = await client.call<unknown>('worktree.show', {
          worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
        })
        const workspace = z
          .object({ worktree: z.object({ id: z.string().min(1) }) })
          .parse(selected.result)
        state = createWorkflowExecution(
          definition,
          input,
          { worktree: `id:${workspace.worktree.id}`, from, sessionId, target },
          status.result.runtimeId
        )
        await store.save(state)
      } else {
        state = await store.read()
        if (
          state.context.target !== target ||
          state.context.from !== from ||
          state.context.sessionId !== sessionId
        ) {
          throw new RuntimeClientError(
            'consumer_fenced',
            'Resume with the same runtime target and coordinator identity as the checkpoint.'
          )
        }
        if (state.runId) {
          const run = await client.call<unknown>('orchestration.runShow', { id: state.runId })
          if (
            z.object({ run: z.object({ id: z.string() }) }).parse(run.result).run.id !== state.runId
          ) {
            throw new RuntimeClientError('consumer_fenced', 'Workflow Run identity mismatch.')
          }
        }
      }
      const runtime = createWorkflowRuntime(client, status.result.runtimeId, store.assertCurrent)
      let result = await advanceWorkflow(state, runtime, store.save)
      while (flags.has('wait') && result.waiting && Date.now() < deadline) {
        await setTimeout(Math.min(2000, Math.max(0, deadline - Date.now())))
        if (Date.now() >= deadline) {
          break
        }
        result = await advanceWorkflow(state, runtime, store.save)
      }
      printWorkflowExecution(state, path, json, result.waiting)
      if (state.status === 'failed') {
        process.exitCode = 1
      }
    })
  } catch (error) {
    if (
      error instanceof RuntimeClientError &&
      [
        'runtime_unavailable',
        'remote_runtime_unavailable',
        'runtime_timeout',
        'invalid_runtime_response'
      ].includes(error.code)
    ) {
      const recovery = z.object({ orchestrationRequestId: z.string() }).safeParse(error.data)
      if (recovery.success) {
        throw new RuntimeClientError(
          error.code,
          'The workflow mutation outcome is unknown. Inspect the saved request ID, then use workflow resume with this checkpoint and the same runtime/coordinator. The executor will reuse its saved request ID; do not start a new run or append --retry-request to workflow commands.',
          { stateFile: path, orchestrationRequestId: recovery.data.orchestrationRequestId }
        )
      }
    }
    throw error
  }
}
