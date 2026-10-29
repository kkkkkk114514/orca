import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { workflowDefinitionSchema } from '../../shared/workflow-definition'
import type { CommandHandler } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime/types'
import { runWorkflow, printWorkflowExecution } from './workflow-execution'
import { readWorkflowCheckpoint } from '../workflow-checkpoint'

const MAX_DEFINITION_BYTES = 1024 * 1024

async function readWorkflowFile(path: string): Promise<unknown> {
  let text: string
  try {
    const file = await open(path, 'r')
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > MAX_DEFINITION_BYTES) {
        throw new RuntimeClientError(
          'invalid_argument',
          'A workflow must be a regular JSON file of at most 1 MiB.'
        )
      }
      text = await file.readFile('utf8')
    } finally {
      await file.close()
    }
  } catch (error) {
    if (error instanceof RuntimeClientError) {
      throw error
    }
    throw new RuntimeClientError('invalid_argument', `Cannot read workflow file: ${path}`)
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new RuntimeClientError('invalid_argument', `Workflow file is not valid JSON: ${path}`)
  }
}

export const WORKFLOW_HANDLERS: Record<string, CommandHandler> = {
  'workflow run': async (ctx) => {
    const definition = await readWorkflowFile(
      resolve(ctx.cwd, getRequiredStringFlag(ctx.flags, 'file'))
    )
    await runWorkflow(ctx, definition)
  },
  'workflow resume': async (ctx) => {
    await runWorkflow(ctx)
  },
  'workflow status': async ({ flags, cwd, json }) => {
    if (flags.has('environment') || flags.has('pairing-code')) {
      throw new RuntimeClientError(
        'invalid_argument',
        'workflow status reads a local checkpoint; omit remote selection flags.'
      )
    }
    const path = resolve(cwd, getRequiredStringFlag(flags, 'state'))
    printWorkflowExecution(await readWorkflowCheckpoint(path), path, json)
  },
  'workflow validate': async ({ flags, cwd, json }) => {
    if (flags.has('environment') || flags.has('pairing-code')) {
      throw new RuntimeClientError(
        'invalid_argument',
        'workflow validate reads local files. Run it on the machine that owns the file without remote selection flags.'
      )
    }
    const input = await readWorkflowFile(resolve(cwd, getRequiredStringFlag(flags, 'file')))
    const parsed = workflowDefinitionSchema.safeParse(input)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message
      }))
      console.log(
        json
          ? JSON.stringify({ valid: false, issues }, null, 2)
          : issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n')
      )
      process.exitCode = 1
      return
    }
    const { name, version, entry, maxSteps, nodes } = parsed.data
    console.log(
      json
        ? JSON.stringify(
            { valid: true, name, version, entry, maxSteps, nodeCount: nodes.length },
            null,
            2
          )
        : `Valid workflow: ${name} (${nodes.length} nodes, at most ${maxSteps} agent steps)`
    )
  }
}
