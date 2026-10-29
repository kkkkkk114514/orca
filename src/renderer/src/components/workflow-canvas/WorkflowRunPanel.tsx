import { useState } from 'react'
import { Pause, Play, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { WorkflowStorageDialog } from './WorkflowStorageDialog'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type { WorkflowDefinition } from '../../../../shared/workflow-definition'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { WorkflowRunSnapshot } from '../../../../shared/workflow-run-contract'
import type { useWorkflowRun } from './use-workflow-run'
import { WorkflowRunTelemetry, WorkflowStepTelemetryDetails } from './WorkflowRunTelemetry'
import { WorkflowStepActivity } from './WorkflowStepActivity'

export type WorkflowExecutionTarget = {
  target: RuntimeClientTarget
  worktreeId: string
  label: string
}

export function workflowPhaseLabel(phase: WorkflowRunSnapshot['phase']): string {
  switch (phase) {
    case 'starting':
      return translate('workflows.runStarting', 'Starting')
    case 'running':
      return translate('workflows.runRunning', 'Running')
    case 'paused':
      return translate('workflows.runPaused', 'Scheduling paused')
    case 'succeeded':
      return translate('workflows.runSucceeded', 'Succeeded')
    case 'failed':
      return translate('workflows.runFailed', 'Failed')
    case 'attention':
      return translate('workflows.runAttention', 'Needs attention')
  }
}

export function WorkflowCanvasRunMode({
  finished,
  viewingRun,
  onToggle
}: {
  finished: boolean
  viewingRun: boolean
  onToggle: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1">
        {finished
          ? viewingRun
            ? translate(
                'workflows.viewingCompletedCanvas',
                'Viewing this run’s canvas (read-only).'
              )
            : translate(
                'workflows.editingNextDraft',
                'This run has ended. Edit the next draft here; its run records stay unchanged.'
              )
          : translate(
              'workflows.runningCanvasReadOnly',
              'The running workflow is read-only. You can view node records and navigate the canvas.'
            )}
      </span>
      {finished && (
        <Button size="sm" variant="outline" onClick={onToggle}>
          {viewingRun
            ? translate('workflows.editNextDraft', 'Edit next draft')
            : translate('workflows.viewRunCanvas', 'View this run’s canvas')}
        </Button>
      )}
    </div>
  )
}

export function WorkflowRunPanel({
  definition,
  workflowId,
  executionTarget,
  run
}: {
  definition: WorkflowDefinition | undefined
  workflowId?: string
  executionTarget: WorkflowExecutionTarget | null
  run: ReturnType<typeof useWorkflowRun>
}) {
  const [open, setOpen] = useState(false)
  const [detachOpen, setDetachOpen] = useState(false)
  const [input, setInput] = useState('')
  const { snapshot, binding, busy, error } = run
  const execution = snapshot?.execution
  const finished = snapshot?.phase === 'succeeded' || snapshot?.phase === 'failed'
  return (
    <section
      className="shrink-0 border-b bg-background"
      aria-label={translate('workflows.runPanel', 'Workflow execution')}
    >
      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {binding
            ? binding.workspaceLabel
            : (executionTarget?.label ??
              translate(
                'workflows.selectWorkspace',
                'Select a workspace in the sidebar to run this workflow.'
              ))}
        </span>
        {binding ? (
          <>
            <span className="text-xs" role="status">
              {snapshot
                ? workflowPhaseLabel(snapshot.phase)
                : translate('workflows.runConnecting', 'Connecting to the host…')}
              {execution ? ` · ${execution.steps.length}/${execution.definition.maxSteps}` : ''}
            </span>
            {finished ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={run.clear}>
                {translate('workflows.newRun', 'New run')}
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !snapshot || snapshot.phase === 'paused'}
                  onClick={() => {
                    void run.pause()
                  }}
                >
                  <Pause />
                  {translate('workflows.pauseScheduling', 'Pause scheduling')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    busy ||
                    !snapshot ||
                    snapshot.phase === 'running' ||
                    snapshot.phase === 'starting'
                  }
                  onClick={() => {
                    void run.resume()
                  }}
                >
                  <RotateCcw />
                  {translate('workflows.resumeRun', 'Resume')}
                </Button>
              </>
            )}
          </>
        ) : (
          <Button
            size="sm"
            disabled={!definition || !executionTarget || busy}
            onClick={() => setOpen(true)}
          >
            <Play />
            {translate('workflows.run', 'Run workflow')}
          </Button>
        )}
        {binding && !finished && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDetachOpen(true)}>
            {translate('workflows.stopViewing', 'Stop viewing')}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="px-4 pb-2 text-xs text-destructive">
          {binding && snapshot
            ? translate(
                'workflows.runSyncFailed',
                'Status could not be refreshed. The host may still be executing. {{message}}',
                { message: error }
              )
            : error}
        </p>
      )}
      {binding && !snapshot && error && (
        <p className="px-4 pb-2 text-xs text-muted-foreground">
          {translate(
            'workflows.runNotLoadedHint',
            'No run record has been loaded. Stop viewing to return to the draft and check its configuration; this does not stop host workers.'
          )}
        </p>
      )}
      {snapshot?.error && (
        <p role="alert" className="px-4 pb-2 text-xs text-destructive">
          {snapshot.error}
        </p>
      )}
      {snapshot?.waiting && (
        <p className="px-4 pb-2 text-2xs text-muted-foreground">{snapshot.waiting}</p>
      )}
      {execution?.reason === 'step_limit' && (
        <p className="px-4 pb-2 text-xs text-destructive">
          {translate(
            'workflows.stepLimitReached',
            'The maximum step budget was reached. No further node was started.'
          )}
        </p>
      )}
      {snapshot?.phase === 'paused' && (
        <p className="px-4 pb-2 text-2xs text-muted-foreground">
          {translate(
            'workflows.pauseHint',
            'Already started workers keep running. Resume to collect their reports and schedule the next node.'
          )}
        </p>
      )}
      {execution && (
        <details className="px-4 pb-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {translate('workflows.runHistory', 'Step history and reports')}
          </summary>
          <ol className="max-h-40 space-y-2 overflow-y-auto scrollbar-sleek pt-2">
            {execution.steps.map((step) => (
              <li key={step.startRequestId} className="border-l pl-3">
                <div className="flex flex-wrap gap-2">
                  <span className="font-mono">{step.nodeId}</span>
                  <span>
                    {step.report
                      ? step.report.outcome === 'succeeded'
                        ? translate('workflows.success', 'Success')
                        : translate('workflows.failed', 'Failed')
                      : translate('workflows.awaitingReport', 'Awaiting accepted report')}
                  </span>
                </div>
                {step.dispatchId && (
                  <p className="font-mono text-2xs text-muted-foreground">{step.dispatchId}</p>
                )}
                {snapshot?.telemetry
                  ?.filter((value) => value.dispatchId === step.dispatchId)
                  .map((value) => (
                    <WorkflowStepTelemetryDetails key={value.dispatchId} value={value} />
                  ))}
                {step.report && (
                  <details>
                    <summary className="cursor-pointer text-muted-foreground">
                      {translate('workflows.acceptedReport', 'Accepted worker report')}
                    </summary>
                    <pre className="max-h-40 overflow-y-auto scrollbar-sleek font-mono text-2xs break-words whitespace-pre-wrap">
                      {step.report.body}
                    </pre>
                    {step.report.reportPath && (
                      <p className="break-all font-mono text-2xs">{step.report.reportPath}</p>
                    )}
                  </details>
                )}
                {snapshot?.activity
                  ?.filter((value) => value.dispatchId === step.dispatchId)
                  .map((value) => (
                    <WorkflowStepActivity key={value.dispatchId} value={value} />
                  ))}
              </li>
            ))}
          </ol>
        </details>
      )}
      {binding && finished && <WorkflowStorageDialog binding={binding} />}
      {snapshot?.telemetry && <WorkflowRunTelemetry steps={snapshot.telemetry} />}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) {
            setOpen(value)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{translate('workflows.run', 'Run workflow')}</DialogTitle>
            <DialogDescription>
              {translate(
                'workflows.runDescription',
                'Agents will work in {{workspace}} using the host’s configured CLI accounts and permissions.',
                { workspace: executionTarget?.label ?? '' }
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="workflow-task-input">{translate('workflows.taskInput', 'Task')}</Label>
            <Textarea
              id="workflow-task-input"
              value={input}
              maxLength={64_000}
              className="min-h-32"
              onChange={(event) => setInput(event.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {translate('workflows.runBudget', 'Maximum {{count}} agent steps, including rework.', {
              count: definition?.maxSteps ?? 0
            })}
          </p>
          <DialogFooter>
            <Button
              disabled={!input.trim() || !definition || !executionTarget || busy}
              onClick={() => {
                if (definition && executionTarget) {
                  void run.start(
                    definition,
                    input.trim(),
                    executionTarget.target,
                    executionTarget.worktreeId,
                    executionTarget.label,
                    workflowId
                  )
                  setOpen(false)
                }
              }}
            >
              <Play />
              {translate('workflows.startRun', 'Start')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={detachOpen} onOpenChange={setDetachOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{translate('workflows.stopViewing', 'Stop viewing')}</DialogTitle>
            <DialogDescription>
              {translate(
                'workflows.detachHint',
                'This removes the run from this canvas only. The host and started workers may keep running. Record the run ID before leaving: {{id}}',
                { id: binding?.id ?? '' }
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                run.detach()
                setDetachOpen(false)
              }}
            >
              {translate('workflows.stopViewing', 'Stop viewing')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
