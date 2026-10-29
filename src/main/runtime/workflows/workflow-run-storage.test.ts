import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createWorkflowExecution } from '../../../shared/workflow-executor'
import { workflowDefinitionSchema } from '../../../shared/workflow-definition'
import { clearWorkflowStorage, workflowStoragePlan } from './workflow-run-storage'
import { workflowReportPaths } from './workflow-report-paths'
import { workflowSessionConfiguration } from './workflow-session-configuration'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workflow-cleanup-'))
  roots.push(root)
  const runRoot = join(root, 'run')
  const definition = workflowDefinitionSchema.parse({
    version: 1,
    name: 'Test',
    entry: 'work',
    maxSteps: 1,
    nodes: [
      {
        id: 'work',
        type: 'agent',
        agent: 'dsh',
        prompt: 'Work',
        onSuccess: 'done',
        onFailure: 'done'
      },
      { id: 'done', type: 'end', outcome: 'succeeded' }
    ]
  })
  const execution = createWorkflowExecution(
    definition,
    'Task',
    { worktree: 'id:folder', from: 'term', target: 'owner' },
    'runtime'
  )
  execution.status = 'succeeded'
  execution.cursor = 'done'
  execution.runId = 'run_test'
  execution.steps.push({
    nodeId: 'work',
    taskId: 'task',
    dispatchId: 'ctx_test',
    released: true,
    startRequestId: randomUUID(),
    releaseRequestId: randomUUID(),
    startRuntimeId: 'runtime',
    report: {
      outcome: 'succeeded',
      body: 'Verified',
      messageId: 'message',
      filesModified: [join(root, 'AGENTS.md')]
    }
  })
  const paths = workflowReportPaths(runRoot, 'work', 'ctx_test')
  await mkdir(paths.artifacts, { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), 'Project instructions')
  await writeFile(paths.report, 'Formal report')
  return {
    root,
    runRoot,
    paths,
    execution,
    request: { id: randomUUID(), category: 'artifacts' as const }
  }
}

it('refuses a directory junction instead of following it into project files', async () => {
  const f = await fixture()
  const outside = join(f.root, 'project')
  await mkdir(outside)
  await writeFile(join(outside, 'source.js'), 'source')
  await symlink(
    outside,
    join(f.paths.artifacts, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await expect(workflowStoragePlan(f.runRoot, undefined, f.execution, f.request)).rejects.toThrow(
    'symbolic links'
  )
  expect(await readFile(join(outside, 'source.js'), 'utf8')).toBe('source')
})

it('clears only indexed attachments and refuses a changed preview', async () => {
  const f = await fixture()
  const artifact = join(f.paths.artifacts, 'check.log')
  await writeFile(artifact, 'logs')
  const plan = await workflowStoragePlan(f.runRoot, undefined, f.execution, f.request)
  expect(plan.preview).toMatchObject({ files: 1, bytes: 4, canClear: true })
  await expect(clearWorkflowStorage(plan, '0'.repeat(64))).rejects.toThrow('preview')
  expect(await clearWorkflowStorage(plan, plan.preview.confirmation)).toMatchObject({
    deleted: 1,
    errors: []
  })
  expect(await readFile(f.paths.report, 'utf8')).toBe('Formal report')
  expect(await readFile(join(f.root, 'AGENTS.md'), 'utf8')).toBe('Project instructions')
})

it('changes the conversation fingerprint when CLI config or selected Skill content changes', async () => {
  const f = await fixture()
  const skill = join(f.root, 'SKILL.md')
  const config = join(f.root, '.codex', 'config.toml')
  await mkdir(join(f.root, '.codex'))
  await writeFile(skill, 'First instructions')
  await writeFile(config, 'model = "one"')
  const args = {
    agent: 'codex' as const,
    settings: {
      agentCmdOverrides: {},
      agentDefaultEnv: { codex: { CODEX_HOME: join(f.root, '.codex') } }
    },
    cwd: f.root,
    program: process.execPath,
    skills: [skill]
  }
  const first = await workflowSessionConfiguration(args)
  expect(await workflowSessionConfiguration(args)).toBe(first)
  await writeFile(skill, 'Changed role')
  const second = await workflowSessionConfiguration(args)
  expect(second).not.toBe(first)
  await writeFile(config, 'model = "two"')
  expect(await workflowSessionConfiguration(args)).not.toBe(second)
})
