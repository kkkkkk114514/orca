import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { createOrchestrationRpcHarness } from '../../src/main/runtime/rpc/methods/orchestration/rpc-test-harness'
import { WorkflowHeadlessWorkers } from '../../src/main/runtime/workflows/workflow-headless-workers'
import { createOrchestrationWorkflowRuntime } from '../../src/shared/workflow-orchestration-runtime'
import { advanceWorkflow, createWorkflowExecution } from '../../src/shared/workflow-executor'
import { workflowDefinitionSchema } from '../../src/shared/workflow-definition'
import { getOrchestrationMutationExecutor } from '../../src/main/runtime/rpc/orchestration-mutation-executor'
import type { RuntimeClientSettings } from '../../src/main/runtime/runtime-client-settings-shape'
import { getAppEnvironment, setAppEnvironment } from '../../src/shared/app-environment'
import { getWorkflowRunService } from '../../src/main/runtime/workflows/workflow-host-runtime'
import type { WorkflowRunService } from '../../src/main/runtime/workflows/workflow-run-service'
import * as nodeInventory from '../../src/main/runtime/workflows/workflow-node-inventory'
import { WorkflowHeadlessReceipts } from '../../src/main/runtime/workflows/workflow-headless-receipts'
import {
  resolveWorkflowNodeSession,
  resolveSelectedWorkflowNodeSession
} from '../../src/main/runtime/workflows/workflow-node-session'
import { workflowReportRecordSchema } from '../../src/main/runtime/workflows/workflow-report-record'
import { listWorkflowConversations } from '../../src/main/runtime/workflows/workflow-workspace-conversations'

describe('canvas headless workers with real subprocesses and accepted Orca reports', () => {
  const harness = createOrchestrationRpcHarness()
  let root: string | undefined
  let workers: WorkflowHeadlessWorkers | undefined
  let service: WorkflowRunService | undefined
  let restoreEnvironment: (() => void) | undefined
  afterEach(async () => {
    await service?.dispose()
    service = undefined
    await workers?.dispose()
    workers = undefined
    harness.cleanup()
    vi.restoreAllMocks()
    restoreEnvironment?.()
    restoreEnvironment = undefined
    if (root) {
      await rm(root, { recursive: true, force: true })
    }
  })

  async function setup(mode = 'normal') {
    root = await mkdtemp(join(tmpdir(), 'workflow-headless-'))
    const directory = root
    const { runtime, ctx, db, activeRunId } = harness.setup()
    const script = join(directory, 'cli.mjs')
    await writeFile(
      script,
      `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const agent = process.env.TEST_AGENT;
if (process.env.TEST_MODE === 'hang') {
 console.log(JSON.stringify({ type: 'tool_call', tool: 'shell', input: { command: 'npm test' } }));
 setInterval(() => {}, 1000);
}
else if (process.env.TEST_MODE === 'broken') { console.log('authentication required'); process.exitCode = 2; }
else {
 const log = 'visits.jsonl';
 const visits = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\\n').map(JSON.parse) : [];
 const resumeFlag = agent === 'dsh' ? '--session-id' : '--resume';
 const resumeIndex = process.argv.indexOf(resumeFlag);
 const resumed = agent === 'codex' ? process.argv.includes('resume') : resumeIndex >= 0;
 const sessionId = resumed ? (agent === 'codex' ? process.argv.at(-2) : process.argv[resumeIndex + 1]) : randomUUID();
 const sessions = existsSync('sessions.json') ? JSON.parse(readFileSync('sessions.json', 'utf8')) : {};
 if (resumed && sessions[sessionId] !== agent) throw new Error('Cannot resume another agent or an unknown session');
 sessions[sessionId] = agent;
 writeFileSync('sessions.json', JSON.stringify(sessions));
 const prompt = process.argv.at(-1).includes('Business specification') ? process.argv.at(-1) : process.argv[process.argv.indexOf('--prompt') + 1];
 const artifacts = process.env.ORCA_WORKFLOW_ARTIFACTS_DIRECTORY;
 if (artifacts) {
   if (!existsSync(artifacts)) throw new Error('Artifact directory not prepared before launch');
   writeFileSync(join(artifacts, 'agent-note.txt'), agent);
 }
 const patchIndex = process.argv.indexOf('--patch');
 const patch = patchIndex >= 0 ? JSON.parse(readFileSync(process.argv[patchIndex + 1], 'utf8')) : undefined;
 const provider = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ? JSON.parse(readFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, 'utf8')).config.defaultModelSelection : undefined;
 appendFileSync(log, JSON.stringify({ agent, sessionId, resumed, prompt, patch, provider, permission: process.env.DSH_PERMISSION_MODE, argv: process.argv.slice(2) }) + '\\n');
 if (process.env.TEST_MODE === 'interrupt' && !resumed) {
   console.log(JSON.stringify(agent === 'codex' ? {type:'thread.started',thread_id:sessionId} : {type:agent === 'dsh' ? 'session' : 'session.created',sessionId}));
   setInterval(() => {}, 1000);
   await new Promise(() => {});
 }
 const priorVisits = visits.filter(v => v.sessionId === sessionId).length;
 const failed = (agent === 'zcode' || agent === 'codex') && visits.filter(v => v.agent === agent).length < (process.env.TEST_MODE === 'twice-failed' ? 2 : 1);
 writeFileSync('artifact.txt', agent + ': ' + (failed ? 'failed' : 'succeeded'));
 const filesModified = process.env.TEST_MODE === 'many-files' ? Array.from({ length: 22 }, (_, i) => 'artifact-' + i + '.txt') : ['artifact.txt'];
 if (process.env.TEST_MODE === 'many-files') for (const file of filesModified) writeFileSync(file, agent);
 const report = JSON.stringify({ outcome: failed ? 'failed' : 'succeeded', body: failed ? 'QA assertion failed: fix the divisor' : 'work complete; verification passed', filesModified });
 if (agent === 'codex') {
   console.log(JSON.stringify({ type: 'thread.started', thread_id: resumed && process.env.TEST_MODE === 'session-mismatch' ? randomUUID() : sessionId }));
   if (!(resumed && process.env.TEST_MODE === 'historical-output')) console.log(JSON.stringify({ type: 'turn.started' }));
   console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: report } }));
   console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100 * (priorVisits + 1), cached_input_tokens: 20 + 80 * priorVisits, output_tokens: 5 * (priorVisits + 1) } }));
 } else if (agent === 'dsh') {
   console.log(JSON.stringify({ type: 'session', sessionId }));
   console.log(JSON.stringify({ type: 'status', phase: 'turn_start' }));
   console.log(JSON.stringify({ type: 'status', phase: 'step_end', usage: { inputTokens: 100, cacheReadTokens: resumed ? 80 : 20, outputTokens: 5 } }));
   console.log(JSON.stringify({ type: 'final', text: report }));
 } else console.log(JSON.stringify({ sessionId, turnId: randomUUID(), usage: { inputTokens: 100, cacheReadTokens: resumed ? 80 : 20, outputTokens: 5 }, response: report }, null, 2));
}
`
    )
    const settings = {
      disabledTuiAgents: [],
      agentCmdOverrides: {
        dsh: process.execPath,
        zcode: process.execPath,
        codex: process.execPath
      },
      agentDefaultArgs: {
        dsh: JSON.stringify(script),
        zcode: JSON.stringify(script),
        codex: JSON.stringify(script)
      },
      agentDefaultEnv: {
        dsh: { TEST_AGENT: 'dsh', TEST_MODE: mode },
        zcode: { TEST_AGENT: 'zcode', TEST_MODE: mode },
        codex: { TEST_AGENT: 'codex', TEST_MODE: mode }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies every settings field consumed by the headless launcher.
    vi.spyOn(runtime, 'getClientSettings').mockReturnValue(settings as RuntimeClientSettings)
    vi.spyOn(runtime, 'showTerminalWorkspaceLaunchScope').mockResolvedValue({
      id: 'folder:fixture',
      path: directory,
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
    let index = 0
    vi.spyOn(runtime, 'createTerminal').mockImplementation(async () => ({
      handle: `term_worker_${++index}`,
      worktreeId: 'folder:fixture',
      surface: 'background'
    }))
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_coord'
        ? harness.coordinatorPaneKey
        : `tab_${handle}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
    )
    vi.spyOn(runtime, 'showTerminal').mockRejectedValue(new Error('test transport has no renderer'))
    vi.spyOn(runtime, 'resolveTerminalHandleByProcessIncarnation').mockReturnValue(null)
    vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue('exited')
    const mutations = getOrchestrationMutationExecutor(runtime)
    async function call(name: string, input: unknown, requestId?: string): Promise<unknown> {
      const method = harness.findMethod(name)
      const params: unknown = method.params?.parse(input)
      return mutations.run(
        { id: crypto.randomUUID(), authToken: '', method: name, orchestrationRequestId: requestId },
        params,
        async (mutation) => {
          if (name === 'orchestration.workerStart') {
            return workers?.start(params, mutation?.identity)
          }
          if (name === 'orchestration.workerShow') {
            await workers?.inspect(z.object({ dispatch: z.string() }).parse(params).dispatch)
          }
          return method.handler(params, {
            ...ctx,
            orchestrationMutation: mutation?.identity,
            recordMutationReceipt: mutation?.recordReceipt,
            replayedMutationReceipt: mutation?.replayedReceipt,
            markMutationEffectPossible: mutation?.markEffectPossible,
            markWorkerDoneMutationEffectFree: mutation?.markWorkerDoneEffectFree
          })
        }
      )
    }
    workers = new WorkflowHeadlessWorkers(runtime, join(directory, 'private'), call)
    const adapter = createOrchestrationWorkflowRuntime({
      runtimeId: runtime.getRuntimeId(),
      call,
      assertCurrent: () => {},
      devMode: true,
      nativeNodeLaunch: true,
      error: (_code, message) => new Error(message)
    })
    const definition = workflowDefinitionSchema.parse({
      version: 1,
      name: 'Headless repair',
      entry: 'develop',
      maxSteps: 8,
      nodes: [
        {
          id: 'develop',
          type: 'agent',
          agent: 'dsh',
          prompt: 'Develop and repair',
          onSuccess: 'test',
          onFailure: 'failed'
        },
        {
          id: 'test',
          type: 'agent',
          agent: 'zcode',
          prompt: 'Test',
          onSuccess: 'done',
          onFailure: 'develop'
        },
        { id: 'done', type: 'end', outcome: 'succeeded' },
        { id: 'failed', type: 'end', outcome: 'failed' }
      ]
    })
    const state = createWorkflowExecution(
      definition,
      'isolated test input',
      { from: 'term_coord', worktree: 'folder:fixture', target: 'local' },
      runtime.getRuntimeId()
    )
    state.runId = activeRunId
    return { adapter, state, runtime, db, call, directory }
  }

  it.each(['dsh', 'codex', 'zcode'] as const)(
    'interrupts a real %s subprocess and resumes the same visit and conversation',
    async (agent) => {
      const f = await setup('interrupt')
      const node = f.state.definition.nodes.find((candidate) => candidate.id === 'develop')
      if (node?.type !== 'agent') {
        throw new Error('Missing fixture node')
      }
      node.agent = agent
      await advanceWorkflow(f.state, f.adapter, async () => {})
      const step = f.state.steps[0]
      if (!step.dispatchId || !workers) {
        throw new Error('Missing dispatched worker')
      }
      const dispatchId = step.dispatchId
      const receipts = new WorkflowHeadlessReceipts(join(f.directory, 'private'))
      await vi.waitFor(
        async () => expect((await receipts.read(dispatchId)).sessionId).toBeTruthy(),
        { timeout: 10_000 }
      )
      const sessionId = (await receipts.read(dispatchId)).sessionId
      await workers.interrupt(dispatchId)
      expect((await receipts.read(dispatchId)).status).toBe('paused')
      expect(f.state.steps).toHaveLength(1)
      await workers.resume(dispatchId, 'Keep the existing keyboard controls.')
      await vi.waitFor(
        async () => expect((await receipts.read(dispatchId)).status).toBe('settled'),
        { timeout: 10_000 }
      )
      const saved = await receipts.read(dispatchId)
      expect(saved.sessionId).toBe(sessionId)
      expect(saved.telemetry?.sessionMode).toBe('resumed')
      const visits = z
        .array(z.object({ sessionId: z.string(), resumed: z.boolean(), prompt: z.string() }))
        .parse(
          (await readFile(join(f.directory, 'visits.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        )
      expect(visits).toHaveLength(2)
      expect(visits[1]).toMatchObject({ sessionId, resumed: true })
      expect(visits[1].prompt).toContain('Keep the existing keyboard controls.')
      expect(f.state.steps).toHaveLength(1)
    }
  )

  it('accepts all 22 modified paths, routes the report to QA and completes the repair loop', async () => {
    const f = await setup('many-files')
    await vi.waitFor(
      async () => {
        await advanceWorkflow(f.state, f.adapter, async () => {})
        expect(f.state.status).toBe('succeeded')
      },
      { timeout: 30_000, interval: 100 }
    )
    expect(f.state.steps).toHaveLength(4)
    for (const step of f.state.steps) {
      expect(step.report?.filesModified).toHaveLength(22)
      expect(step.report?.filesModified.at(-1)).toBe('artifact-21.txt')
      expect(step.released).toBe(true)
    }
    const visits = (await readFile(join(f.directory, 'visits.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(visits[1].agent).toBe('zcode')
    expect(visits[1].prompt).toContain('artifact-21.txt')
  }, 35_000)

  it('applies independent node settings to real subprocesses and removes temporary configurations', async () => {
    const f = await setup()
    vi.spyOn(nodeInventory, 'inspectDsh').mockResolvedValue({
      profiles: [],
      plugins: [
        { id: 'model', name: '@deepseek-ai/dsh-agent-default-model', disabled: false, config: {} },
        { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-policy', disabled: false, config: {} },
        { id: 'approval', name: '@deepseek-ai/dsh-user-approval', disabled: false, config: {} }
      ]
    })
    vi.spyOn(nodeInventory, 'inspectZcode').mockResolvedValue({
      providerPath: join(f.directory, 'provider.json'),
      provider: {
        schemaVersion: 1,
        config: { defaultModelSelection: { providerId: 'test-plan', modelId: 'inherited-model' } }
      },
      user: {},
      project: {},
      plugins: [],
      servers: {}
    })
    f.state.definition = workflowDefinitionSchema.parse({
      ...f.state.definition,
      version: 2,
      nodes: f.state.definition.nodes.map((node) =>
        node.type === 'agent'
          ? {
              ...node,
              launch:
                node.agent === 'dsh'
                  ? { model: 'developer-model', effort: 'high', permission: 'danger-full-access' }
                  : { model: 'tester-model', effort: 'low', permission: 'guarded' }
            }
          : node
      )
    })
    for (let count = 0; count < 100 && f.state.status !== 'succeeded'; count++) {
      await advanceWorkflow(f.state, f.adapter, async () => {})
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(f.state.status).toBe('succeeded')
    const visits = (await readFile(join(f.directory, 'visits.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(visits).toHaveLength(4)
    for (const visit of visits) {
      if (visit.agent === 'dsh') {
        expect(visit.permission).toBe('danger-full-access')
        expect(visit.patch).toContainEqual({
          id: 'model',
          config: { model: 'developer-model', reasoningEffort: 'high' }
        })
        expect(visit.provider).toBeUndefined()
      } else {
        expect(visit.permission).toBeUndefined()
        expect(visit.patch).toBeUndefined()
        expect(visit.provider).toMatchObject({
          providerId: 'test-plan',
          modelId: 'tester-model',
          options: { reasoningLevel: 'low' }
        })
        expect(visit.argv).toEqual(expect.arrayContaining(['--mode', 'guarded']))
      }
    }
    await workers?.dispose()
    expect(
      (await readdir(join(f.directory, 'private'))).filter((name) => name.startsWith('node-'))
    ).toEqual([])
  }, 30_000)

  it.each(['zcode', 'codex'] as const)(
    'runs %s testing through repair loops, forwards reports and releases every worker',
    async (tester) => {
      const f = await setup(tester === 'codex' ? 'twice-failed' : 'normal')
      const visitsPerNode = tester === 'codex' ? 3 : 2
      f.state.definition = workflowDefinitionSchema.parse({
        ...f.state.definition,
        nodes: f.state.definition.nodes.map((node) =>
          node.type === 'agent' && node.id === 'test' ? { ...node, agent: tester } : node
        )
      })
      const originalEnvironment = getAppEnvironment()
      restoreEnvironment = () => setAppEnvironment(originalEnvironment)
      setAppEnvironment({
        ...originalEnvironment,
        getPath: (name) => (name === 'userData' ? f.directory : originalEnvironment.getPath(name)),
        onWillQuit: () => {}
      })
      vi.spyOn(f.runtime, 'dedupeTerminalCreate').mockResolvedValue({
        handle: 'term_coord',
        worktreeId: 'folder:fixture',
        surface: 'background'
      })
      service = getWorkflowRunService(f.runtime)
      const id = crypto.randomUUID()
      const workflowId = crypto.randomUUID()
      await service.start('desktop', {
        id,
        workflowId,
        worktree: 'id:folder:fixture',
        definition: f.state.definition,
        input: f.state.input
      })
      try {
        await vi.waitFor(
          async () => {
            const snapshot = await service?.show('desktop', id)
            if (snapshot?.phase === 'attention') {
              throw new Error(JSON.stringify(snapshot))
            }
            expect(snapshot).toMatchObject({ phase: 'succeeded' })
          },
          { timeout: 45_000, interval: 100 }
        )
      } catch (error) {
        console.error(
          'Headless host execution at timeout:',
          JSON.stringify(await service.show('desktop', id))
        )
        throw error
      }
      const execution = (await service.show('desktop', id)).execution
      if (!execution) {
        throw new Error('Missing host execution checkpoint')
      }
      expect(execution.steps.map((step) => step.report?.outcome)).toEqual(
        tester === 'codex'
          ? ['succeeded', 'failed', 'succeeded', 'failed', 'succeeded', 'succeeded']
          : ['succeeded', 'failed', 'succeeded', 'succeeded']
      )
      expect(execution.steps.every((step) => step.released)).toBe(true)
      const visits = z
        .array(
          z.object({
            agent: z.string(),
            prompt: z.string(),
            sessionId: z.string(),
            resumed: z.boolean()
          })
        )
        .parse(
          (await readFile(join(f.directory, 'visits.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        )
      expect(visits.map((visit) => visit.agent)).toEqual(
        Array.from({ length: visitsPerNode }, () => ['dsh', tester]).flat()
      )
      expect(visits[2]?.prompt).toContain('QA assertion failed: fix the divisor')
      expect(visits.map((visit) => visit.resumed)).toEqual(
        visits.map((_visit, index) => index >= 2)
      )
      expect(visits[0]?.sessionId).toBe(visits[2]?.sessionId)
      expect(visits[1]?.sessionId).toBe(visits[3]?.sessionId)
      expect(visits[0]?.sessionId).not.toBe(visits[1]?.sessionId)
      const telemetry = (await service.show('desktop', id)).telemetry
      expect(telemetry?.map((step) => step.sessionMode)).toEqual(
        visits.map((_visit, index) => (index >= 2 ? 'resumed' : 'new'))
      )
      expect(telemetry?.map((step) => step.inputTokens)).toEqual(Array(visitsPerNode * 2).fill(100))
      expect(telemetry?.map((step) => step.cachedInputTokens)).toEqual(
        visits.map((_visit, index) => (index >= 2 ? 80 : 20))
      )
      expect(telemetry?.map((step) => step.outputTokens)).toEqual(Array(visitsPerNode * 2).fill(5))
      expect(telemetry?.every((step) => step.durationMs >= 0)).toBe(true)
      const receipts = new WorkflowHeadlessReceipts(join(f.directory, 'workflow-headless'))
      const previousDispatch = execution.steps[0]?.dispatchId
      if (!previousDispatch) {
        throw new Error('Missing developer dispatch')
      }
      const previous = await receipts.read(previousDispatch)
      if (!previous.binding) {
        throw new Error('Missing node session binding')
      }
      const session = {
        runtime: f.runtime,
        receipts,
        coordinator: 'term_coord',
        previousDispatch,
        binding: previous.binding
      }
      expect(await resolveWorkflowNodeSession(session)).toMatchObject({
        sessionId: visits[0]?.sessionId
      })
      expect(
        await resolveWorkflowNodeSession({ ...session, previousDispatch: undefined })
      ).toBeUndefined()
      const crossRunSession = {
        ...session,
        previousDispatch: undefined,
        coordinator: 'term_new_coordinator',
        binding: { ...previous.binding, runId: 'run_new' },
        selected: {
          key: 'a'.repeat(64),
          workspaceId: previous.binding.workspaceId,
          agent: previous.binding.agent,
          sessionId: previous.sessionId ?? 'missing'
        }
      }
      expect(await resolveSelectedWorkflowNodeSession(crossRunSession)).toMatchObject({
        sessionId: previous.sessionId
      })
      expect(
        await resolveSelectedWorkflowNodeSession({
          ...crossRunSession,
          binding: { ...crossRunSession.binding, configurationKey: 'f'.repeat(64) }
        })
      ).toMatchObject({ sessionId: previous.sessionId })

      expect(
        await resolveWorkflowNodeSession({
          ...session,
          binding: { ...previous.binding, configurationKey: 'f'.repeat(64) }
        })
      ).toBeUndefined()
      for (const binding of [
        { ...previous.binding, runId: 'run_other' },
        { ...previous.binding, nodeId: 'test' },
        { ...previous.binding, workspaceId: 'folder:other' },
        { ...previous.binding, agent: 'codex' as const }
      ]) {
        await expect(resolveWorkflowNodeSession({ ...session, binding })).rejects.toThrow()
      }
      for (const [index, step] of execution.steps.entries()) {
        if (!step.report?.reportPath) {
          throw new Error('Missing report archive')
        }
        const archived = workflowReportRecordSchema.parse(
          JSON.parse(await readFile(step.report.reportPath, 'utf8'))
        )
        expect(archived.taskId).toBe(step.taskId)
        expect(archived.dispatchId).toBe(step.dispatchId)
        expect(archived.report.messageId).toBe(step.report.messageId)
        expect(archived.source?.dispatchId).toBe(execution.steps[index - 1]?.dispatchId)
        expect(archived.route.dispatchedTo?.dispatchId).toBe(execution.steps[index + 1]?.dispatchId)
        expect(
          await readFile(
            join(dirname(step.report.reportPath), 'artifacts', 'agent-note.txt'),
            'utf8'
          )
        ).toBe(step.nodeId === 'develop' ? 'dsh' : tester)
        expect(JSON.parse(f.db.getTask(step.taskId ?? '')?.result ?? 'null')).toMatchObject({
          provenance: 'worker_report',
          outcome: step.report?.outcome
        })
        expect(f.db.getWorkerTerminalResourceByOwner(step.dispatchId ?? '')?.release_state).toBe(
          'released'
        )
        expect(
          f.db.getMutationReceipt(
            f.db.getOrCreateLocalMutationCallerFingerprint(),
            step.startRequestId
          )?.state
        ).toBe('completed')
      }
      const logs = await service.storage('desktop', { id, category: 'logs' })
      expect(logs.files).toBeGreaterThan(0)
      expect(
        await service.storage('desktop', { id, category: 'logs', confirmation: logs.confirmation })
      ).toMatchObject({ deleted: logs.files, errors: [] })
      expect((await service.session('desktop', { id, nodeId: 'develop' })).cleared).toBe(true)
      const nextId = crypto.randomUUID()
      await service.start('desktop', {
        id: nextId,
        workflowId,
        worktree: 'id:folder:fixture',
        definition: f.state.definition,
        input: 'Second independent task; use the current routing identity'
      })
      await vi.waitFor(
        async () => {
          const next = await service?.show('desktop', nextId)
          expect(next?.error).toBeUndefined()
          expect(next?.phase).toBe('succeeded')
        },
        { timeout: 20_000, interval: 100 }
      )
      const second = (await service.show('desktop', nextId)).execution
      expect(second?.runId).not.toBe(execution.runId)
      expect(second?.steps).toHaveLength(2)
      expect(second?.steps.every((step) => step.released)).toBe(true)
      const all = z
        .array(
          z.object({
            agent: z.string(),
            sessionId: z.string(),
            resumed: z.boolean(),
            prompt: z.string()
          })
        )
        .parse(
          (await readFile(join(f.directory, 'visits.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        )
      expect(all.slice(-2).map((visit) => visit.sessionId)).toEqual(
        visits.slice(-2).map((visit) => visit.sessionId)
      )
      expect(all.slice(-2).every((visit) => visit.resumed)).toBe(true)
      expect(all.slice(-2).every((visit) => visit.prompt.includes('Second independent task'))).toBe(
        true
      )
      expect(
        (await service.show('desktop', nextId)).telemetry?.map((step) => step.inputTokens)
      ).toEqual([100, 100])
      const freshId = crypto.randomUUID()
      await service.start('desktop', {
        id: freshId,
        workflowId,
        worktree: 'id:folder:fixture',
        definition: {
          ...f.state.definition,
          version: 2,
          nodes: f.state.definition.nodes.map((node) =>
            node.type === 'agent' ? { ...node, conversation: { mode: 'new' as const } } : node
          )
        },
        input: 'Fresh task'
      })
      await vi.waitFor(
        async () => {
          const snapshot = await service?.show('desktop', freshId)
          expect(snapshot?.error).toBeUndefined()
          expect(snapshot?.phase).toBe('succeeded')
        },
        { timeout: 20_000, interval: 100 }
      )
      const fresh = (await service.show('desktop', freshId)).telemetry
      expect(fresh?.every((step) => step.sessionMode === 'new')).toBe(true)
      expect(
        fresh?.every((step) => !visits.some((visit) => visit.sessionId === step.sessionId))
      ).toBe(true)
      const choices = await listWorkflowConversations(f.runtime, 'desktop', 'id:folder:fixture')
      const manualId = crypto.randomUUID()
      const manualDefinition = workflowDefinitionSchema.parse({
        ...f.state.definition,
        version: 2,
        nodes: f.state.definition.nodes.map((node) => {
          if (node.type !== 'agent') {
            return node
          }
          const sessionId = visits[node.id === 'develop' ? 0 : 1]?.sessionId
          const selected = choices.choices.find((item) => item.conversation.sessionId === sessionId)
          if (!selected) {
            throw new Error('Original conversation missing')
          }
          return {
            ...node,
            prompt: `${node.prompt}\nUpdated node instructions`,
            conversation: { mode: 'existing', key: selected.row.key }
          }
        })
      })
      await service.start('desktop', {
        id: manualId,
        workflowId,
        worktree: 'id:folder:fixture',
        definition: manualDefinition,
        input: 'Second independent task with explicitly selected older conversations'
      })
      await vi.waitFor(
        async () => expect((await service?.show('desktop', manualId))?.phase).toBe('succeeded'),
        { timeout: 20_000, interval: 100 }
      )
      expect(
        (await service.show('desktop', manualId)).telemetry?.map((step) => step.sessionId)
      ).toEqual(visits.slice(0, 2).map((visit) => visit.sessionId))
    },
    90_000
  )

  it('fences a process error instead of treating it as a failed test or re-launching it on resume', async () => {
    const f = await setup('broken')
    await advanceWorkflow(f.state, f.adapter, async () => {})
    await vi.waitFor(
      async () => {
        await expect(advanceWorkflow(f.state, f.adapter, async () => {})).rejects.toThrow(
          'No business-failure transition'
        )
      },
      { timeout: 10_000, interval: 50 }
    )
    expect(f.state.steps).toHaveLength(1)
    expect(f.state.steps[0]?.report).toBeUndefined()
    expect(f.runtime.createTerminal).toHaveBeenCalledTimes(1)
    await expect(advanceWorkflow(f.state, f.adapter, async () => {})).rejects.toThrow()
    expect(f.runtime.createTerminal).toHaveBeenCalledTimes(1)
  }, 30_000)

  it.each(['session-mismatch', 'historical-output'])(
    'refuses %s during a resumed Codex visit without accepting a report or starting another process',
    async (mode) => {
      const f = await setup(mode)
      f.state.definition = workflowDefinitionSchema.parse({
        ...f.state.definition,
        nodes: f.state.definition.nodes.map((node) =>
          node.type === 'agent' && node.id === 'test' ? { ...node, agent: 'codex' } : node
        )
      })
      const message = mode === 'session-mismatch' ? 'requested node session' : 'new turn'
      await vi.waitFor(
        async () => {
          await expect(advanceWorkflow(f.state, f.adapter, async () => {})).rejects.toThrow(message)
        },
        { timeout: 20_000, interval: 100 }
      )
      expect(f.state.steps).toHaveLength(4)
      expect(f.state.steps.at(-1)?.report).toBeUndefined()
      expect(f.runtime.createTerminal).toHaveBeenCalledTimes(4)
      await expect(advanceWorkflow(f.state, f.adapter, async () => {})).rejects.toThrow(message)
      expect(f.runtime.createTerminal).toHaveBeenCalledTimes(4)
    },
    30_000
  )

  it('accepts host settlement when a receipt read still returns the preceding running snapshot', async () => {
    const f = await setup()
    await advanceWorkflow(f.state, f.adapter, async () => {})
    const dispatch = f.state.steps[0]?.dispatchId
    if (!dispatch) {
      throw new Error('Missing initial dispatch')
    }
    const receipts = new WorkflowHeadlessReceipts(join(f.directory, 'private'))
    await vi.waitFor(
      async () => {
        expect((await receipts.read(dispatch)).status).toBe('settled')
      },
      { timeout: 10_000 }
    )
    await workers?.dispose()
    const readReceipt = WorkflowHeadlessReceipts.prototype.read
    vi.spyOn(WorkflowHeadlessReceipts.prototype, 'read').mockImplementationOnce(async function (
      this: WorkflowHeadlessReceipts,
      id
    ) {
      const value = await readReceipt.call(this, id)
      return { ...value, status: 'running', report: undefined }
    })
    await expect(workers?.inspect(dispatch)).resolves.toBeUndefined()
    expect(f.db.getDispatchContextById(dispatch)?.status).toBe('completed')
    const inspected = await f.adapter.inspectStep(f.state, f.state.steps[0])
    expect(inspected).toMatchObject({ report: { outcome: 'succeeded' } })
  }, 30_000)

  it('replays the same start receipt without another process and aborts it on host shutdown', async () => {
    const f = await setup('hang')
    const requestId = crypto.randomUUID()
    const params = {
      from: 'term_coord',
      worktree: 'folder:fixture',
      run: f.state.runId,
      agent: 'dsh',
      spec: 'wait'
    }
    const first = await f.call('orchestration.workerStart', params, requestId)
    const identity = z.object({ taskId: z.string(), dispatchId: z.string() }).parse(first)
    expect(await f.call('orchestration.workerStart', params, requestId)).toMatchObject({
      ...identity,
      mutation: { requestId, replayed: true }
    })
    expect(f.runtime.createTerminal).toHaveBeenCalledTimes(1)
    const receipts = new WorkflowHeadlessReceipts(join(f.directory, 'private'))
    await vi.waitFor(
      async () => {
        const [activity] = (await workers?.activity([identity.dispatchId])) ?? []
        expect(activity?.entries.some((entry) => entry.text.includes('npm test'))).toBe(true)
        expect(activity?.state).toBe('running')
      },
      { timeout: 10_000 }
    )
    const activity = await receipts.readActivity(identity.dispatchId)
    if (!activity) {
      throw new Error('Missing live activity')
    }
    receipts.saveActivity({ ...activity, lastOutputAt: Date.now() - 180_000 })
    expect((await workers?.activity([identity.dispatchId]))?.[0]?.state).toBe('quiet')
    expect(f.db.getDispatchContextById(identity.dispatchId)?.status).toBe('dispatched')
    await workers?.dispose()
    expect((await workers?.activity([identity.dispatchId]))?.[0]?.state).toBe('interrupted')
    const { dispatchId } = z.object({ dispatchId: z.string() }).parse(first)
    expect(
      JSON.parse(await readFile(join(f.directory, 'private', `${dispatchId}.json`), 'utf8'))
    ).toMatchObject({ status: 'error' })
    expect(f.db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
  }, 30_000)
})
