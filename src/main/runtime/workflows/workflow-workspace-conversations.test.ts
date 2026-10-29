import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AiVaultSession } from '../../../shared/ai-vault-types'
import { workflowDefinitionSchema } from '../../../shared/workflow-definition'
import {
  listWorkflowConversations,
  resolveWorkflowConversations
} from './workflow-workspace-conversations'
import {
  claimWorkflowConversation,
  isWorkflowConversationBusy
} from './workflow-conversation-lease'
import { selectWorkspaceSession } from './workspace-session-history'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => state.root })
}))
vi.mock('../../ai-vault/structured-session-ownership', () => ({
  assertLegacyAiVaultResumeAllowed: vi.fn()
}))

beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'workflow-conversations-'))
})
afterEach(async () => {
  await rm(state.root, { recursive: true, force: true })
})

function session(
  id: string,
  updated: string,
  agent: AiVaultSession['agent'] = 'codex',
  cwd = '/project'
): AiVaultSession {
  return {
    id,
    sessionId: id,
    agent,
    cwd,
    executionHostId: 'local',
    title: id,
    filePath: join(state.root, `${id}.jsonl`),
    codexHome: null,
    branch: null,
    model: null,
    createdAt: updated,
    updatedAt: updated,
    modifiedAt: updated,
    messageCount: 2,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  }
}
function fixture() {
  const list = vi.fn(async () => ({
    sessions: [
      session('older', '2026-01-01'),
      session('newer', '2026-02-01'),
      session('other-agent', '2026-03-01', 'zcode'),
      session('other-workspace', '2026-04-01', 'codex', '/other')
    ],
    issues: []
  }))
  const runtime = {
    listAiVaultSessions: list,
    showTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      id: 'folder:test',
      path: '/project',
      connectionId: null
    }))
  }
  const request = {
    id: randomUUID(),
    worktree: 'id:folder:test',
    input: 'New task',
    definition: workflowDefinitionSchema.parse({
      version: 2,
      name: 'Select',
      entry: 'plan',
      maxSteps: 2,
      nodes: [
        {
          id: 'plan',
          type: 'agent',
          agent: 'codex',
          prompt: 'A changed role is allowed',
          onSuccess: 'done',
          onFailure: 'done'
        },
        { id: 'done', type: 'end', outcome: 'succeeded' }
      ]
    })
  }
  return { runtime, request, list }
}

it('selects the latest conversation of this agent and exact workspace; no history starts fresh', async () => {
  const f = fixture()
  expect((await resolveWorkflowConversations(f.runtime, 'owner', f.request)).plan.sessionId).toBe(
    'newer'
  )
  const plan = f.request.definition.nodes[0]
  if (plan.type !== 'agent') {
    throw new Error('Missing agent')
  }
  plan.agent = 'dsh'
  expect(await resolveWorkflowConversations(f.runtime, 'owner', f.request)).toEqual({})
})

it('honors explicit history and fresh selections without a previous-run configuration constraint', async () => {
  const f = fixture()
  const history = await listWorkflowConversations(f.runtime, 'owner', f.request.worktree, 'codex')
  const older = history.choices.find((item) => item.conversation.sessionId === 'older')
  if (!older) {
    throw new Error('Missing conversation')
  }
  const preview = await selectWorkspaceSession(f.runtime, 'owner', {
    worktree: f.request.worktree,
    key: older.history.key
  })
  expect(preview.item.native?.sessionId).toBe('older')
  const plan = f.request.definition.nodes[0]
  if (plan.type !== 'agent') {
    throw new Error('Missing agent')
  }
  plan.conversation = { mode: 'existing', key: older.row.key }
  plan.launch = { security: { access: 'workspace-write' } }
  expect((await resolveWorkflowConversations(f.runtime, 'owner', f.request)).plan.sessionId).toBe(
    'older'
  )
  plan.agent = 'zcode'
  await expect(resolveWorkflowConversations(f.runtime, 'owner', f.request)).rejects.toThrow(
    'another agent or workspace'
  )
  plan.conversation = { mode: 'new' }
  f.list.mockClear()
  expect(await resolveWorkflowConversations(f.runtime, 'owner', f.request)).toEqual({})
  expect(f.list).not.toHaveBeenCalled()
})

it('prevents concurrent writers and permits reuse after the active claim is released', async () => {
  const f = fixture()
  const source = (await resolveWorkflowConversations(f.runtime, 'owner', f.request)).plan
  const root = join(state.root, 'workflow-headless')
  const release = await claimWorkflowConversation(root, source)
  try {
    expect(await isWorkflowConversationBusy(root, source)).toBe(true)
    await expect(claimWorkflowConversation(root, source)).rejects.toThrow('already in use')
    expect((await resolveWorkflowConversations(f.runtime, 'owner', f.request)).plan.sessionId).toBe(
      'older'
    )
  } finally {
    await release()
  }
  expect(await isWorkflowConversationBusy(root, source)).toBe(false)
  const next = await claimWorkflowConversation(root, source)
  await next()
})
