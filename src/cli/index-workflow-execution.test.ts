import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workflowExecutionSchema } from '../shared/workflow-execution'
import { RuntimeClientError } from './runtime/types'

const { callMock, constructorMock } = vi.hoisted(() => ({
  callMock: vi.fn(),
  constructorMock: vi.fn()
}))
vi.mock('./runtime-client', async () => {
  const errors = await import('./runtime/types.js')
  return {
    ...errors,
    RuntimeClient: class {
      userDataPath = 'test-profile'
      environmentSelector = null
      isRemote = false
      call = callMock
      constructor() {
        constructorMock()
      }
    }
  }
})
import { main } from './index'

const originalExitCode = process.exitCode
let directory: string
let completed: boolean
const graph = {
  version: 1,
  name: 'CLI execution',
  entry: 'work',
  maxSteps: 1,
  nodes: [
    {
      id: 'work',
      type: 'agent',
      agent: 'dsh',
      prompt: 'Develop',
      onSuccess: 'done',
      onFailure: 'failed'
    },
    { id: 'done', type: 'end', outcome: 'succeeded' },
    { id: 'failed', type: 'end', outcome: 'failed' }
  ]
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workflow-cli-'))
  await writeFile(join(directory, 'definition.json'), JSON.stringify(graph))
  completed = false
  process.exitCode = undefined
  vi.clearAllMocks()
  vi.stubEnv('ORCA_AGENT_SESSION_ID', '')
  vi.stubEnv('ORCA_TERMINAL_HANDLE', '')
  vi.stubEnv('ORCA_ENVIRONMENT', '')
  vi.stubEnv('ORCA_PAIRING_CODE', '')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  callMock.mockImplementation(async (method: string) => {
    const results: Record<string, unknown> = {
      'status.get': { runtimeId: 'runtime-test' },
      'worktree.show': { worktree: { id: 'folder-test' } },
      'orchestration.runCreate': { run: { id: 'run-test' } },
      'orchestration.runShow': { run: { id: 'run-test' } },
      'orchestration.workerStart': {
        taskId: 'task-test',
        dispatchId: 'dispatch-test',
        state: 'ready'
      },
      'orchestration.workerShow': {
        dispatch: {
          id: 'dispatch-test',
          runId: 'run-test',
          taskId: 'task-test',
          status: completed ? 'completed' : 'dispatched'
        },
        worker: {
          state: completed ? 'succeeded' : 'ready',
          stage: completed ? 'settled' : 'input_accepted'
        }
      },
      'orchestration.taskList': {
        tasks: [
          {
            id: 'task-test',
            status: 'completed',
            result: JSON.stringify({
              provenance: 'worker_report',
              outcome: 'succeeded',
              messageId: 'accepted-message',
              body: 'revision test; actual checks passed',
              filesModified: []
            })
          }
        ]
      },
      'orchestration.workerRelease': { state: 'released' }
    }
    if (!(method in results)) {
      throw new Error(`Unexpected RPC: ${method}`)
    }
    return { id: 'rpc', ok: true, result: results[method], _meta: { runtimeId: 'runtime-test' } }
  })
})

afterEach(async () => {
  process.exitCode = originalExitCode
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

const startArgs = [
  'workflow',
  'run',
  'definition.json',
  '--state',
  'run.json',
  '--input',
  'Implement a feature',
  '--worktree',
  'folder:test',
  '--from',
  'term-coordinator',
  '--json'
]

describe('workflow execution CLI', () => {
  it('recovers a lost worker-start response through resume rather than an invalid retry flag', async () => {
    const normalCall = callMock.getMockImplementation()
    if (!normalCall) {
      throw new Error('Missing RPC boundary')
    }
    callMock.mockImplementation(
      async (method: string, params: unknown, options?: { orchestrationRequestId?: string }) => {
        if (method === 'orchestration.workerStart') {
          throw new RuntimeClientError('runtime_timeout', 'Lost response', {
            orchestrationRequestId: options?.orchestrationRequestId,
            originalCommand: ['orca', 'workflow', 'run', 'definition.json']
          })
        }
        return normalCall(method, params, options)
      }
    )
    await main(startArgs, directory)
    expect(process.exitCode).toBe(1)
    const pending = workflowExecutionSchema.parse(
      JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'))
    )
    expect(pending.steps[0].dispatchId).toBeUndefined()
    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('\n')
    expect(output).toContain('workflow resume')
    expect(output).not.toContain('"retryCommand"')
    process.exitCode = undefined
    callMock.mockImplementation(normalCall)
    await main(
      ['workflow', 'resume', 'run.json', '--from', 'term-coordinator', '--json'],
      directory
    )
    const attempts = callMock.mock.calls.filter((call) => call[0] === 'orchestration.workerStart')
    expect(attempts).toHaveLength(2)
    expect(
      attempts.every((call) => call[2].orchestrationRequestId === pending.steps[0].startRequestId)
    ).toBe(true)
    expect(
      JSON.parse(await readFile(join(directory, 'run.json'), 'utf8')).steps[0].dispatchId
    ).toBe('dispatch-test')
  })
  it('leaves the worker running when the observation deadline expires', async () => {
    await main([...startArgs, '--wait', '--timeout-ms', '1'], directory)
    const state = workflowExecutionSchema.parse(
      JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'))
    )
    expect(state.status).toBe('running')
    expect(state.steps).toHaveLength(1)
    expect(state.steps[0].released).toBe(false)
    expect(
      callMock.mock.calls.some((call) =>
        ['orchestration.workerStop', 'orchestration.workerRelease'].includes(call[0])
      )
    ).toBe(false)
    expect(process.exitCode).toBeUndefined()
  })
  it('starts once in a non-git folder, reloads from another cwd, and resumes to completion', async () => {
    await main(startArgs, directory)
    const path = join(directory, 'run.json')
    const saved = workflowExecutionSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    expect(saved).toMatchObject({
      status: 'running',
      runId: 'run-test',
      context: { worktree: 'id:folder-test' },
      steps: [{ dispatchId: 'dispatch-test' }]
    })
    expect(saved.definition).toEqual(graph)
    completed = true
    await main(['workflow', 'resume', path, '--from', 'term-coordinator', '--json'], tmpdir())
    const final = workflowExecutionSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    expect(final).toMatchObject({
      status: 'succeeded',
      cursor: 'done',
      steps: [{ released: true }]
    })
    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])).activeDispatch
    ).toBeNull()
    expect(
      callMock.mock.calls.filter((call) => call[0] === 'orchestration.workerStart')
    ).toHaveLength(1)
    expect(process.exitCode).toBeUndefined()
  })

  it('refuses another coordinator before touching the saved worker', async () => {
    await main(startArgs, directory)
    callMock.mockClear()
    await main(['workflow', 'resume', 'run.json', '--from', 'term-other', '--json'], directory)
    expect(process.exitCode).toBe(1)
    expect(callMock.mock.calls.map((call) => call[0])).toEqual(['status.get'])
    expect(JSON.parse(await readFile(join(directory, 'run.json'), 'utf8')).status).toBe('running')
  })

  it('reads saved status offline and leaves both checkpoint and runtime untouched', async () => {
    await main(startArgs, directory)
    const before = await readFile(join(directory, 'run.json'), 'utf8')
    constructorMock.mockClear()
    callMock.mockClear()
    await main(['workflow', 'status', 'run.json', '--json'], directory)
    expect(constructorMock).not.toHaveBeenCalled()
    expect(callMock).not.toHaveBeenCalled()
    expect(await readFile(join(directory, 'run.json'), 'utf8')).toBe(before)
  })

  it('sends the saved request identity with the actual worker-start RPC', async () => {
    await main(startArgs, directory)
    const saved = workflowExecutionSchema.parse(
      JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'))
    )
    const started = callMock.mock.calls.find((call) => call[0] === 'orchestration.workerStart')
    expect(started?.[2]).toMatchObject({ orchestrationRequestId: saved.steps[0].startRequestId })
    expect(started?.[1].spec).toContain('Implement a feature')
    expect(started?.[1].spec).toContain('Develop')
  })
})
