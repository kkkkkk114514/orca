import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  dshProfile,
  nodeEnvironment,
  workflowNodeHome,
  zcodeProviderPath
} from './workflow-node-inventory'
import type { WorkflowHeadlessAgent, WorkflowHeadlessSettings } from './workflow-headless-command'
import type { WorkflowNodeLaunch } from '../../../shared/workflow-node-launch'

export async function workflowSessionConfiguration(args: {
  agent: WorkflowHeadlessAgent
  settings: WorkflowHeadlessSettings
  cwd: string
  program: string
  launch?: WorkflowNodeLaunch
  skills: string[]
}) {
  const { agent, settings, cwd, launch } = args
  const env = nodeEnvironment(agent, settings)
  const home = workflowNodeHome(agent, settings)
  const paths = [...args.skills]
  if (/\.(?:cmd|bat|ps1|mjs|cjs|js)$/i.test(args.program)) {
    paths.push(args.program)
  }
  if (agent === 'dsh') {
    const profile = join(
      env.DSH_HOME ?? join(home, '.dsh'),
      'profiles',
      dshProfile(settings, launch?.profile)
    )
    paths.push(
      ...['cordis.yml', 'cordis.patch.yml', 'package.json', 'pnpm-lock.yaml'].map((file) =>
        join(profile, file)
      )
    )
  } else if (agent === 'zcode') {
    paths.push(
      await zcodeProviderPath(settings, launch?.profile, cwd),
      join(home, '.zcode', 'cli', 'config.json'),
      join(cwd, 'zcode.json'),
      join(cwd, '.zcode', 'config.json')
    )
  } else {
    const root = env.CODEX_HOME ?? join(home, '.codex')
    paths.push(join(root, 'config.toml'), join(cwd, '.codex', 'config.toml'))
  }
  const digest = createHash('sha256')
  for (const path of paths.sort()) {
    digest.update(JSON.stringify(path))
    try {
      digest.update(await readFile(path))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
      digest.update('missing')
    }
  }
  return digest.digest('hex')
}
