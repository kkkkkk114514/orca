import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { workflowDefinitionSchema } from '../shared/workflow-definition'
import { createWorkflowExecution } from '../shared/workflow-executor'
import { readWorkflowCheckpoint, withWorkflowCheckpoint } from './workflow-checkpoint'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workflow-checkpoint-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function state() {
  return createWorkflowExecution(
    workflowDefinitionSchema.parse({
      version: 1,
      name: 'Done',
      entry: 'done',
      maxSteps: 1,
      nodes: [{ id: 'done', type: 'end', outcome: 'succeeded' }]
    }),
    'Task',
    { worktree: 'folder:non-git', target: 'test-target' },
    'runtime'
  )
}

describe('workflow checkpoints', () => {
  it('persists and reloads the actual checkpoint across separate store lifetimes', async () => {
    const path = join(directory, 'state.json')
    const original = state()
    await withWorkflowCheckpoint(path, true, async (store) => {
      await store.save(original)
    })
    await withWorkflowCheckpoint(path, false, async (store) => {
      expect(await store.read()).toEqual(original)
    })
    expect(await readWorkflowCheckpoint(path)).toEqual(original)
  })

  it('refuses to overwrite an existing run', async () => {
    const path = join(directory, 'existing.json')
    await writeFile(path, 'User file')
    await expect(
      withWorkflowCheckpoint(path, true, async (store) => {
        await store.save(state())
      })
    ).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('User file')
  })

  it('excludes a concurrent executor and releases its lock after errors', async () => {
    const path = join(directory, 'state.json')
    await withWorkflowCheckpoint(path, true, async (store) => {
      await store.save(state())
      await expect(withWorkflowCheckpoint(path, false, async () => {})).rejects.toThrow(
        'already being held'
      )
    })
    await expect(
      withWorkflowCheckpoint(path, false, async () => {
        throw new Error('Interrupted')
      })
    ).rejects.toThrow('Interrupted')
    await withWorkflowCheckpoint(path, false, async (store) => {
      expect((await store.read()).input).toBe('Task')
    })
  })

  it('rejects corrupt checkpoint data before executing an operation', async () => {
    const path = join(directory, 'broken.json')
    await writeFile(path, '{')
    await expect(
      withWorkflowCheckpoint(path, false, async (store) => {
        await store.read()
      })
    ).rejects.toThrow('checkpoint could not be used')
  })
})
