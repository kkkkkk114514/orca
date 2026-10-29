import { LoaderCircle } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { WorkflowStepActivity as StepActivity } from '../../../../shared/workflow-step-activity'
import type { WorkflowRunSnapshot } from '../../../../shared/workflow-run-contract'

export function WorkflowSelectedNodeActivity({
  nodeId,
  snapshot
}: {
  nodeId: string | undefined
  snapshot: WorkflowRunSnapshot | null
}) {
  const step = snapshot?.execution?.steps.findLast((value) => value.nodeId === nodeId)
  const activity = snapshot?.activity?.find((value) => value.dispatchId === step?.dispatchId)
  return activity ? (
    <div className="border-t p-4">
      <WorkflowStepActivity value={activity} />
    </div>
  ) : null
}

export function workflowActivityLabel(state: StepActivity['state']) {
  switch (state) {
    case 'running':
      return translate('workflows.activityRunning', 'CLI running')
    case 'quiet':
      return translate('workflows.activityQuiet', 'No recent output; still waiting')
    case 'finished':
      return translate('workflows.activityFinished', 'CLI finished')
    case 'interrupted':
      return translate('workflows.activityInterrupted', 'Execution interrupted; inspect status')
  }
}

export function WorkflowActivityStatus({ state }: { state: StepActivity['state'] }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {state === 'running' && (
        <LoaderCircle aria-hidden="true" className="size-3 motion-safe:animate-spin" />
      )}
      {workflowActivityLabel(state)}
    </span>
  )
}

export function WorkflowStepActivity({ value }: { value: StepActivity }) {
  return (
    <details className="text-xs" open>
      <summary className="cursor-pointer text-muted-foreground">
        <WorkflowActivityStatus state={value.state} />
      </summary>
      <p className="text-2xs text-muted-foreground">
        {translate(
          'workflows.activityTail',
          'Recent activity (up to 30 records per node; latest 5 visits). Older records omitted: {{count}}.',
          { count: value.omitted }
        )}
      </p>
      <p className="text-2xs text-muted-foreground">
        {translate('workflows.activityTime', 'Started: {{start}} · Last output: {{last}}', {
          start: new Date(value.startedAt).toLocaleTimeString(),
          last: value.lastOutputAt ? new Date(value.lastOutputAt).toLocaleTimeString() : '—'
        })}
      </p>
      {value.state === 'quiet' && (
        <p className="text-2xs text-muted-foreground">
          {translate(
            'workflows.activityQuietHint',
            'No CLI output for two minutes. This does not prove a hang; execution continues without a fixed deadline.'
          )}
        </p>
      )}
      <ol
        aria-label={translate('workflows.activityLog', 'Node activity log')}
        className="max-h-48 space-y-1 overflow-y-auto scrollbar-sleek font-mono text-2xs"
      >
        {value.entries.map((entry) => (
          <li key={entry.id ?? `${entry.at}:${entry.text}`}>
            <time className="text-muted-foreground">{new Date(entry.at).toLocaleTimeString()}</time>{' '}
            <span className="break-words whitespace-pre-wrap">{entry.text}</span>
          </li>
        ))}
      </ol>
    </details>
  )
}
