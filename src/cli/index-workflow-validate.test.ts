import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./runtime-client', async () => {
  const { RuntimeClientError, RuntimeRpcFailureError } = await import('./runtime/types.js')
  return {
    RuntimeClient: class {
      constructor() {
        throw new Error('Workflow validation must not construct a runtime client')
      }
    },
    RuntimeClientError,
    RuntimeRpcFailureError
  }
})

import { main } from './index'

const example = readFileSync(
  resolve(__dirname, '../../examples/workflows/development-test-repair.json'),
  'utf8'
)
const originalExitCode = process.exitCode
let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-workflow-'))
  process.exitCode = undefined
})

afterEach(() => {
  process.exitCode = originalExitCode
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

describe('orca workflow validate', () => {
  it('keeps browser page targeting out of local validation and its help', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['workflow', 'validate', '--help'], directory)

    expect(output.mock.calls[0]?.[0]).toContain('--file <path>')
    expect(output.mock.calls[0]?.[0]).not.toContain('--page')
    output.mockClear()

    await main(
      ['workflow', 'validate', 'workflow.json', '--page', 'browser-page', '--json'],
      directory
    )

    expect(process.exitCode).toBe(1)
    expect(output.mock.calls.map((call) => String(call[0])).join('')).toContain(
      'Unknown flag --page'
    )
  })

  it('validates a relative BOM-prefixed file in a non-git folder without a runtime', async () => {
    vi.stubEnv('ORCA_ENVIRONMENT', 'stale-unreachable-environment')
    vi.stubEnv('ORCA_PAIRING_CODE', 'stale-pairing-code')
    writeFileSync(join(directory, 'workflow.json'), `\uFEFF${example}`)
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['workflow', 'validate', 'workflow.json', '--json'], directory)

    expect(process.exitCode).toBeUndefined()
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
      valid: true,
      name: 'Development, test and repair',
      version: 1,
      entry: 'develop',
      maxSteps: 8,
      nodeCount: 4
    })
  })

  it('prints a useful human-readable summary for the named file flag', async () => {
    const file = join(directory, 'workflow with spaces.json')
    writeFileSync(file, example)
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['workflow', 'validate', '--file', file], directory)

    expect(process.exitCode).toBeUndefined()
    expect(output.mock.calls[0]?.[0]).toBe(
      'Valid workflow: Development, test and repair (4 nodes, at most 8 agent steps)'
    )
  })

  it('returns field-level graph issues and a failing exit code', async () => {
    writeFileSync(
      join(directory, 'workflow.json'),
      example.replace('"entry": "develop"', '"entry": "missing"')
    )
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['workflow', 'validate', 'workflow.json', '--json'], directory)

    expect(process.exitCode).toBe(1)
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([{ path: 'entry', message: 'Entry node does not exist' }])
    })
  })

  it.each([
    ['malformed JSON', '{"prompt":"SENTINEL_NOT_A_REAL_KEY",', 'not valid JSON'],
    ['an oversized file', ' '.repeat(1024 * 1024 + 1), 'at most 1 MiB']
  ])('rejects %s without echoing file contents', async (_name, contents, message) => {
    writeFileSync(join(directory, 'workflow.json'), contents)
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['workflow', 'validate', 'workflow.json', '--json'], directory)

    const error = output.mock.calls.map((call) => String(call[0])).join('')
    expect(process.exitCode).toBe(1)
    expect(error).toContain(message)
    expect(error).not.toContain('SENTINEL_NOT_A_REAL_KEY')
  })

  it('reports an unreadable file without trying to start Orca', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['workflow', 'validate', 'missing.json', '--json'], directory)

    expect(process.exitCode).toBe(1)
    expect(output.mock.calls.map((call) => String(call[0])).join('')).toContain(
      'Cannot read workflow file'
    )
  })

  it.each(['environment', 'pairing-code'])(
    'rejects explicit --%s rather than checking the wrong machine',
    async (flag) => {
      const output = vi.spyOn(console, 'log').mockImplementation(() => {})

      await main(
        ['workflow', 'validate', 'workflow.json', `--${flag}`, 'remote', '--json'],
        directory
      )

      expect(process.exitCode).toBe(1)
      expect(output.mock.calls.map((call) => String(call[0])).join('')).toContain(
        'without remote selection flags'
      )
    }
  )
})
