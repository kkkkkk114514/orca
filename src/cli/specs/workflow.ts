import type { CommandSpec } from '../args'

export const WORKFLOW_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['workflow', 'run'],
    summary: 'Execute a workflow using Orca workers and a durable local checkpoint',
    usage:
      'orca workflow run <file> --state <path> --input <task> --worktree <selector> [--from <handle>] [--wait] [--timeout-ms <n>] [--json]',
    allowedFlags: ['file', 'state', 'input', 'worktree', 'from', 'wait', 'timeout-ms'],
    positionalArgs: ['file'],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'Requires a running compatible Orca runtime and an existing coordinator terminal or injected agent session.',
      'The definition and checkpoint live on the CLI machine; workers run in the selected runtime workspace, including folder workspaces.',
      'Use a new state path for each run. The checkpoint records the validated definition, input, target, request IDs, workers and reports.',
      'Advances until waiting for an accepted worker report. --wait polls for up to --timeout-ms (default 30000, maximum 86400000); timeout leaves the worker running.',
      'Only accepted worker reports select success/failure branches. Startup failures, permissions, lost contact and ambiguous mutations require inspection.',
      'Completed workers are released through Orca before another step starts. maxSteps includes repeated agent visits.',
      'No model-specific commands, credentials or machine paths are embedded in the executor; agent launch settings belong to Orca.'
    ],
    examples: [
      'orca workflow run examples/workflows/development-test-repair.json --state ./run.json --input "Implement the requested change" --worktree current --wait'
    ]
  },
  {
    path: ['workflow', 'resume'],
    summary: 'Resume a checkpoint without starting duplicate workers',
    usage: 'orca workflow resume <state> [--from <handle>] [--wait] [--timeout-ms <n>] [--json]',
    allowedFlags: ['state', 'from', 'wait', 'timeout-ms'],
    positionalArgs: ['state'],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'Use the same runtime selection and coordinator identity as the original run.',
      'Reuses saved mutation request IDs and inspects the current Dispatch before advancing.',
      'An unresolved mutation spanning a runtime restart is refused until its saved request has been inspected.',
      'Concurrent executors are excluded by a checkpoint lock. After a forcibly killed process, a stale lock expires after two minutes.',
      'Stopping this CLI leaves already-started workers running; resume from the saved checkpoint.'
    ]
  },
  {
    path: ['workflow', 'status'],
    summary: 'Read a local workflow checkpoint without connecting to Orca',
    usage: 'orca workflow status <state> [--json]',
    allowedFlags: ['state'],
    positionalArgs: ['state'],
    notes: ['Reads saved progress only. Use workflow resume to reconcile live worker results.']
  },
  {
    path: ['workflow', 'validate'],
    summary: 'Validate a local workflow definition without running agents',
    usage: 'orca workflow validate <file> [--json]',
    allowedFlags: ['file'],
    positionalArgs: ['file'],
    notes: [
      'Reads a version 1 JSON definition from the CLI machine; no running Orca app is required.',
      'Checks supported agents, unique node IDs, transitions, reachability, end nodes and an explicit step limit.',
      'An agent node routes to onSuccess or onFailure; end nodes declare succeeded or failed.',
      'maxSteps bounds the number of agent steps in a run, including repair loops.',
      'This command validates definitions only. Use workflow run to execute the graph and enforce its step limit.',
      'For a remote file, run this command on the machine that owns the file. Remote selection flags are not supported.'
    ],
    examples: ['orca workflow validate examples/workflows/development-test-repair.json --json']
  }
]
