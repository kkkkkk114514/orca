import { translate } from '@/i18n/i18n'
import { formatTokens } from '../stats/usage-formatters'
import { formatNativeChatDuration } from '../../../../shared/native-chat-turn-status'
import {
  summarizeWorkflowTelemetry,
  type WorkflowStepTelemetry
} from '../../../../shared/workflow-step-telemetry'

function UsageValues({
  value
}: {
  value: Pick<
    WorkflowStepTelemetry,
    'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'durationMs'
  >
}) {
  const missing = translate('workflows.usageUnavailable', 'Not reported')
  const count = (tokens: number | null) => (tokens === null ? missing : formatTokens(tokens))
  const values = [
    [translate('workflows.usageInput', 'Input'), count(value.inputTokens)],
    [translate('workflows.usageCached', 'Cached input'), count(value.cachedInputTokens)],
    [translate('workflows.usageOutput', 'Output'), count(value.outputTokens)],
    [
      translate('workflows.usageDuration', 'Execution time'),
      formatNativeChatDuration(value.durationMs / 1000)
    ]
  ]
  return (
    <dl className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted-foreground">
      {values.map(([label, content]) => (
        <div key={label} className="flex gap-1">
          <dt>{label}</dt>
          <dd>{content}</dd>
        </div>
      ))}
    </dl>
  )
}

export function WorkflowRunTelemetry({ steps }: { steps: WorkflowStepTelemetry[] }) {
  if (!steps.length) {
    return null
  }
  const summary = summarizeWorkflowTelemetry(steps)
  return (
    <div
      className="space-y-1 px-4 pb-2"
      aria-label={translate('workflows.usageSummary', 'Reported usage')}
    >
      <p className="text-2xs text-muted-foreground">
        {translate(
          'workflows.usageCoverage',
          'Complete token usage reported for {{known}}/{{total}} finished steps.',
          { known: summary.reportedSteps, total: steps.length }
        )}
        {summary.cacheHitRate !== null &&
          ` · ${translate('workflows.usageCacheRate', 'Input cache hit rate {{rate}}%', { rate: (summary.cacheHitRate * 100).toFixed(1) })}`}
      </p>
      <UsageValues value={summary} />
    </div>
  )
}

export function WorkflowStepTelemetryDetails({ value }: { value: WorkflowStepTelemetry }) {
  const session =
    value.sessionMode === 'resumed'
      ? translate('workflows.sessionResumed', 'Resumed node session')
      : value.sessionMode === 'new'
        ? translate('workflows.sessionNew', 'New node session')
        : translate('workflows.sessionUnavailable', 'Session ID not reported')
  return (
    <div
      className="space-y-1 py-1"
      aria-label={translate('workflows.stepUsage', 'Step session and usage')}
    >
      <p className="text-2xs text-muted-foreground">{session}</p>
      {value.sessionId && (
        <p className="break-all font-mono text-2xs text-muted-foreground">{value.sessionId}</p>
      )}
      <UsageValues value={value} />
    </div>
  )
}
