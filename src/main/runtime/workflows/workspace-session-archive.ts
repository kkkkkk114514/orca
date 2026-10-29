import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lock } from 'proper-lockfile'
import { z } from 'zod'
import { writeDurableSecureJsonFile } from '../../../shared/secure-file'

const archivesSchema = z.record(z.string().regex(/^[a-f0-9]{64}$/), z.number().nonnegative())
export class WorkspaceSessionArchive {
  constructor(private readonly root: string) {}
  private directory(owner: string) {
    return join(this.root, createHash('sha256').update(owner).digest('hex'))
  }
  private path(owner: string, workspace: string) {
    return join(
      this.directory(owner),
      `${createHash('sha256').update(workspace).digest('hex')}.json`
    )
  }
  async read(owner: string, workspace: string) {
    try {
      return archivesSchema.parse(JSON.parse(await readFile(this.path(owner, workspace), 'utf8')))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return {}
      }
      throw error
    }
  }
  async set(owner: string, workspace: string, key: string, archived: boolean) {
    await mkdir(this.directory(owner), { recursive: true, mode: 0o700 })
    const release = await lock(this.directory(owner), {
      realpath: false,
      retries: { retries: 4, minTimeout: 20, maxTimeout: 100 }
    })
    try {
      const state = await this.read(owner, workspace)
      if (archived) {
        state[key] = Date.now()
      } else {
        delete state[key]
      }
      writeDurableSecureJsonFile(this.path(owner, workspace), state)
    } finally {
      await release()
    }
  }
}
