import { randomUUID } from 'node:crypto'
import { open, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { lock } from 'proper-lockfile'
import { workflowExecutionSchema, type WorkflowExecution } from './workflow-execution'
import { renameFileWithWindowsRetryAsync } from './windows-retry-file-operations'

const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024

export async function readWorkflowCheckpoint(path: string): Promise<WorkflowExecution> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_CHECKPOINT_BYTES) {
      throw new Error('Invalid checkpoint size')
    }
    return workflowExecutionSchema.parse(JSON.parse(await file.readFile('utf8')))
  } finally {
    await file.close()
  }
}

export async function withWorkflowCheckpoint<T>(
  path: string,
  create: boolean,
  operation: (store: {
    read(): Promise<WorkflowExecution>
    save(state: WorkflowExecution): Promise<void>
    assertCurrent(): void
  }) => Promise<T>
): Promise<T> {
  const canonical = create
    ? join(await realpath(dirname(path)), basename(path))
    : await realpath(path)
  let compromised: Error | undefined
  const release = await lock(canonical, {
    realpath: false,
    retries: 0,
    stale: 120_000,
    update: 5000,
    onCompromised(error) {
      compromised = error
    }
  })
  const assertLock = () => {
    if (compromised) {
      throw compromised
    }
  }
  try {
    if (create) {
      const file = await open(canonical, 'wx', 0o600)
      await file.close()
    }
    return await operation({
      assertCurrent: assertLock,
      async read() {
        assertLock()
        return await readWorkflowCheckpoint(canonical)
      },
      async save(state) {
        assertLock()
        const text = `${JSON.stringify(state, null, 2)}\n`
        if (Buffer.byteLength(text) > MAX_CHECKPOINT_BYTES) {
          throw new Error('Workflow checkpoint exceeds 64 MiB')
        }
        const temporary = `${canonical}.${randomUUID()}.tmp`
        try {
          const file = await open(temporary, 'wx', 0o600)
          try {
            await file.writeFile(text)
            await file.sync()
          } finally {
            await file.close()
          }
          assertLock()
          await renameFileWithWindowsRetryAsync(temporary, canonical, () => {
            assertLock()
            return true
          })
        } finally {
          await unlink(temporary).catch((error: unknown) => {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
              throw error
            }
          })
        }
      }
    })
  } finally {
    await release()
  }
}
