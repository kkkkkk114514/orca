# Workflow definitions (experimental)

The version 1 format describes agent steps, success/failure transitions, and explicit end states. `development-test-repair.json` uses DSH for development and ZCode for testing; a failed test routes back to development.

With a CLI built from this branch:

```sh
orca workflow validate examples/workflows/development-test-repair.json --json
```

Validation reads a local JSON file without connecting to a running Orca app or invoking agents. For a file on an SSH host, run the CLI on that host. Explicit `--environment` and `--pairing-code` are rejected because they cannot change which filesystem this command reads. Folder workspaces are supported; a git repository is not required.

## Visual canvas

In a desktop or web client built from this branch, open **Workflows** in the sidebar. The starter graph uses DSH → ZCode, with failed tests returning to development. Select a node to edit its name, CLI agent and instructions; drag output ports to input ports to connect steps. Each agent has one success and one failure destination. Connecting the same output again replaces its previous connection. End nodes declare success or failure. Set the entry node and maximum step budget in Properties.

The canvas supports dragging, pan/zoom, a minimap, automatic arrangement, selection deletion, and up to 50 undo operations. Use the toolbar for undo/redo and deletion; arrow keys move a focused selected node. The Properties button opens a sheet on narrow screens. The editor does not require a repository, git worktree or server connection.

- **Workflow JSON (executor)** exports the strict version-1 definition accepted by the commands below. Invalid graphs disable this export; open the validation issues in the footer to inspect missing instructions, incomplete connections or unreachable steps.
- **Canvas JSON (with layout)** exports a draft with node names, positions and viewport. Incomplete graphs can be backed up and edited later. It is an editor document, not an execution checkpoint or executor input.
- **Import JSON** accepts either format. A failed import preserves the current graph. Files are limited to 8 MB.

The current draft is saved in this client's device storage and restored when returning to the editor. Export Canvas JSON for a portable backup or to transfer it between clients. Drafts are not synchronized with remote hosts. This local subview preserves the existing automation navigation protocol for older remote runtimes.

### Organized canvas reports

Canvas runs keep their existing private `workflow-runs/<caller-hash>/<workflow-id>/run.json` and `execution.json`. Each accepted step also has:

```text
reports/<node-id>/dispatch-<dispatch-id>/
  report.json
  report.md
  artifacts/
```

`report.json` contains the accepted content and message ID, workspace reference, orchestration Run/Task/Dispatch IDs, node agent and visit number, the upstream report identity, the selected success/failure destination, and the actual downstream Task/Dispatch once launched. `execution.json` retains its compatible step index and points `report.reportPath` at this organized report. The original worker receipt/report path is retained as `sourceReportPath`. A rework visit gets another directory; no prior report is replaced. Node IDs containing uppercase letters are encoded, and Windows reserved names escaped consistently across platforms, so case-distinct nodes cannot share a directory.

Orca owns the structured JSON. Markdown is generated from that record; a restart/resume rebuilds the derived view. Report persistence failure stops scheduling, and an existing report with conflicting identity/content requires inspection. A resumed legacy run backfills its existing accepted reports without executing completed agents again; merely viewing an old run remains read-only. The accepted report body remains in the execution checkpoint for older clients.

DSH/ZCode/Codex headless nodes receive their prepared `artifacts/` directory in the prompt and `ORCA_WORKFLOW_ARTIFACTS_DIRECTORY`. Writing there follows the CLI's existing permissions. If the directory is outside its allowed sandbox, the node can keep attachments in the authorized workspace and include their paths in its report. Orca does not broaden CLI permissions, move source files, automatically copy arbitrary attachments, or delete old private receipts. Other canvas agents also receive organized accepted reports; standalone CLI workflow checkpoints retain their existing storage behavior.

### Run from the canvas

Select the execution workspace in the sidebar, open Workflows, choose **Run workflow**, enter the task, and choose **Start**. The workspace can be a folder or a git worktree. The client routes to that workspace's owning runtime; a direct SSH workspace without a routable runtime has no Run action. An older runtime without the additive workflow RPCs shows an update message.

The host creates a background coordinator terminal and continues scheduling independently of the canvas. It uses the same state machine, checkpoints, accepted worker reports and durable orchestration mutations as the CLI executor. Node badges show the last accepted outcome and number of agent visits. Step history keeps earlier failed attempts and their reports, even after a later retry passes. The run uses an immutable definition snapshot; graph editing is locked while that run is attached to the canvas. A completed run offers **New run**.

**Pause scheduling** prevents further node starts. Already started workers continue; **Resume** collects their accepted reports and continues routing. Host restart or a startup/communication error requires explicit Resume, using the recorded mutation IDs and coordinator identity. An ambiguous mutation across a runtime restart remains fenced for inspection. Keep the background coordinator terminal open until the run is finished. It remains available for inspection afterwards.

The client stores the run ID, host route and workspace label on this device. Reopening the canvas reads that same host's run without starting it again. **Stop viewing** removes only this client reference and explains that the host may still execute; it does not stop the workers. Run definitions, input, checkpoints and accepted reports remain under the executing host's private user-data `workflow-runs` directory, partitioned by authenticated caller. A different paired device cannot read or control another caller's run.

Selecting an agent does not install or authenticate its CLI. Canvas DSH, ZCode and Codex steps use a host-owned headless adapter; other agents retain the normal Orca worker launcher. The standalone CLI workflow commands below still use their normal worker launcher. UI-owned checkpoints retain their UI caller identity and are not interchangeable with an external CLI coordinator's checkpoints.

#### DSH / ZCode / Codex headless canvas execution

The adapter resolves the installed CLI on the executing host, honours that agent's executable override, default arguments and environment, runs it in the selected workspace, and submits its final structured report through the same accepted `worker_report` contract. A zero process exit alone is not completion evidence. A valid report with outcome `failed` follows the node's failure edge; outcome `blocked`, process errors, timeouts and missing/malformed reports stop scheduling for inspection. Parent Orca terminal/hook identity is removed from the subprocess environment; the host adapter owns report settlement. The private report and worker output archive retain the final report, not credentials or raw model diagnostics.

For DSH, set `ORCA_WORKFLOW_DSH_PROFILE` in the host launch environment or DSH's existing default environment setting to select a previously authenticated profile. A profile in default arguments (`--profile ...`) takes precedence. WorkBuddy profiles may also need the plugin's `WORKBUDDY_AI_ELECTRON_BIN` pointing to the installed WorkBuddy AI executable. No client path, profile name or account key is hardcoded into product code. ZCode retains the installed command's provider/Coding Plan configuration. Its configured `--mode` is preserved; absent an explicit mode, the adapter uses `build` (or an explicitly set `ORCA_WORKFLOW_ZCODE_MODE`). Non-interactive permission requests need an appropriate CLI configuration; the adapter does not silently turn on `yolo`.

Each headless job has a background terminal identity for Orca custody and report settlement; the model runs as a host subprocess rather than an interactive TUI in that terminal. Its accepted report is available in the canvas history and archived worker output. Pausing scheduling leaves the current process running. Closing/taking over/abandoning its worker terminal cancels that process and fences settlement. Host shutdown cancels processes; after a host restart, an interrupted model is not launched again automatically. A saved final report can be settled again with the same durable request ID if the exact terminal authority still exists. Inspect the dispatch before starting a replacement run after an execution error.

Codex uses its configured CLI's `exec --json` entry point. No interactive Enter is needed. Accounts, default arguments and environment are inherited; the adapter does not raise permissions.

#### Node conversation reuse and usage

Within one canvas run, revisiting the same DSH, ZCode or Codex node resumes its own previously accepted and released CLI session by explicit ID, when the CLI reported one. Development and testing keep separate sessions, even when they use the same CLI and workspace. New runs start new sessions. Existing runs without a recorded session, and changed Orca launch settings, start a fresh session with the full node instructions. Session data is kept in the host's private worker receipts, not in the workspace's `AGENTS.md`.

First visits put the task and fixed node instructions before changing visit information. Resumed visits receive the new upstream report and current visit instructions; the original task and role remain in the CLI conversation. Each visit must verify current files and produce a new completion report. Historical output cannot complete the new visit. A missing session, a mismatched identity, or absence of a confirmed new turn stops for attention; the adapter does not use `--last` or silently retry in another session.

Step history shows new/resumed session identity, execution duration and CLI-reported input, cached-input and output tokens. Codex reports cumulative session usage; the host retains those raw counters and subtracts the previous accepted invocation's counters on resume. Older cumulative Codex receipts are corrected when read. A missing baseline or regressing counter stays unavailable. The usage summary aggregates complete reported fields; missing data is shown as unavailable, not zero. A cache-hit percentage requires both input and cached-input counts. These are invocation measurements, not cumulative session projections or a claim about subscription deductions. Reusing a conversation can increase total input history, so compare total input, cached input and elapsed time rather than cache-hit percentage alone. Other interactive agents and older hosts may omit these measurements. The optional telemetry field does not change execution checkpoint format.

Remote use runs this adapter on the workspace-owning runtime, with that host's installed CLIs and credentials. A direct SSH/WSL path cannot be executed as a local filesystem path. Existing local folder workspaces and git worktrees are both supported. No renderer protocol or canvas document format changed.

## Definition fields

- `version`: currently `1`; unsupported fields and versions are rejected.
- `name`: display name.
- `entry`: ID of the first node.
- `maxSteps`: explicit budget of 1–1000 agent steps, including repeated visits during repair loops.
- `nodes`: 1–100 nodes with unique IDs. Every node must be reachable from the entry and have a possible path to an end.
- Agent node: `id`, `type: "agent"`, supported Orca `agent`, `prompt`, `onSuccess`, and `onFailure` destinations.
- End node: `id`, `type: "end"`, and `outcome: "succeeded"` or `"failed"`.

## Execute and resume

Run from an existing Orca coordinator terminal or an injected agent session. When running from an external shell, supply the coordinator's handle with `--from`; do not use another worker's identity.

```sh
orca workflow run examples/workflows/development-test-repair.json \
  --state ./repair-run.json --input "Implement the requested change and test it" \
  --worktree current --wait --timeout-ms 600000

orca workflow status ./repair-run.json --json
orca workflow resume ./repair-run.json --wait --timeout-ms 600000
```

`run` creates an exclusive local checkpoint and a real Orca Run. Each agent visit starts a new Task/Dispatch using the existing worker launcher. Only a worker report already accepted by Orca selects a transition. Its inline summary, changed files and report path are handed to the next agent, including a failure report on repair visits. Agent instructions must verify their code revision and report real checks; the executor itself does not infer test success from process exit, terminal silence, or arbitrary local report files.

The validated definition, task input, concrete workspace ID, caller, runtime target, mutation request IDs, workers and accepted reports are saved before proceeding. After a lost response, `resume` reuses the persisted request ID rather than issuing a fresh start. A single checkpoint lock excludes concurrent executors; after a forcibly terminated CLI, a stale lock expires after two minutes. Writes use a synced temporary file and atomic replacement. Keep checkpoints in a private directory outside agent edit scope; they contain task prompts and handoff data. Parents must exist, existing checkpoints are never overwritten by `run`, and checkpoints are limited to 64 MiB.

Without `--wait`, commands return when a worker needs to finish. With `--wait`, the CLI polls the authoritative worker result until the deadline (default 30 seconds, maximum one day). The deadline stops polling, leaves the worker running, and preserves the checkpoint for `resume`. Stop the CLI to interrupt observation; it does not automatically stop or reassign a running worker. `status` only reads saved state and needs no running Orca app.

Every repeated agent visit consumes one of `maxSteps`. Reaching an end node on the final allowed visit succeeds or fails as declared; needing another agent after exhausting the budget fails with `reason: "step_limit"`. Completed workers are released through Orca before scheduling their successors. Uncertain release, permission prompts, infrastructure failures and missing accepted reports preserve the current step for inspection. They do not route to `onFailure` as if an agent had reported a business failure. Use `orchestration worker-show` with the returned `activeDispatch` to inspect these cases. Automatic infrastructure retries and coordinator takeover are intentionally not part of this version.

Resume with the same coordinator and runtime selection. A checkpoint is bound to its runtime installation when the host exposes that identity. If a pending mutation spans a runtime restart, the executor refuses to replay it automatically: inspect its saved request ID through `orchestration request-show` and resolve the ambiguity first. Known dispatches can be observed again after a runtime restart; their outcomes remain authoritative.

Remote workers are supported through the CLI's existing `--environment` or `--pairing-code` routing. The definition and checkpoint remain on the CLI machine; use an explicit server-side workspace selector instead of `current`, and use the same target on resume. Report paths are passed to the next worker on that runtime, never read as client-local files. Missing worker identity/report contracts fail closed on older hosts rather than silently falling back to terminal text. Folder workspaces are supported without git commands. The canvas described above reuses this shared state machine on the workspace-owning host.

The standalone CLI executor uses Orca's configured worker launcher; the canvas DSH/ZCode/Codex headless adapter is described above. Agents must already be installed and authenticated on the execution host. Models, accounts and permissions continue to use the existing Orca launch configuration.
