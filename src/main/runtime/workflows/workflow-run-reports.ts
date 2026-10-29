import { readFile } from 'node:fs/promises'
import { writeDurableSecureJsonFile, writeSecureFile } from '../../../shared/secure-file'
import type { WorkflowExecution, WorkflowStepReport } from '../../../shared/workflow-execution'
import {
  renderWorkflowReport,
  workflowReportRecordSchema,
  type WorkflowReportRecord
} from './workflow-report-record'
import { prepareWorkflowReportArtifacts, workflowReportPaths } from './workflow-report-paths'

function reportContent({ route, ...record }: WorkflowReportRecord): string {
  return JSON.stringify({
    ...record,
    route: { nextNodeId: route.nextNodeId, targetType: route.targetType }
  })
}

export class WorkflowRunReports {
  private readonly prepared = new Set<string>()
  private readonly records = new Map<
    string,
    { record: WorkflowReportRecord; report: WorkflowStepReport; recipient?: string }
  >()

  constructor(
    private readonly root: string,
    private readonly workflowId: string,
    private readonly assertCurrent: () => void
  ) {}

  async synchronize(state: WorkflowExecution): Promise<void> {
    if (!state.runId) {
      return
    }
    const visits = new Map<string, number>()
    for (const [index, step] of state.steps.entries()) {
      const visit = (visits.get(step.nodeId) ?? 0) + 1
      visits.set(step.nodeId, visit)
      if (!step.dispatchId || !step.taskId) {
        continue
      }
      const paths = workflowReportPaths(this.root, step.nodeId, step.dispatchId)
      if (!this.prepared.has(step.dispatchId)) {
        this.assertCurrent()
        await prepareWorkflowReportArtifacts(this.root, step.nodeId, step.dispatchId)
        this.prepared.add(step.dispatchId)
      }
      if (!step.report) {
        continue
      }
      const next = state.steps[index + 1]
      const cached = this.records.get(step.dispatchId)
      if (cached?.report === step.report && cached.recipient === next?.dispatchId) {
        continue
      }
      const node = state.definition.nodes.find((candidate) => candidate.id === step.nodeId)
      if (!node || node.type !== 'agent') {
        throw new Error('Report source is not an agent node in this workflow.')
      }
      const nextNodeId = step.report.outcome === 'succeeded' ? node.onSuccess : node.onFailure
      const target = state.definition.nodes.find((candidate) => candidate.id === nextNodeId)
      if (!target || (next && next.nodeId !== nextNodeId)) {
        throw new Error('Report destination does not match the workflow transition.')
      }
      const previous = state.steps[index - 1]
      const existing = cached?.record ?? (await this.read(paths.report))
      const record = workflowReportRecordSchema.parse({
        version: 1,
        workflowId: this.workflowId,
        runId: state.runId,
        workflowName: state.definition.name,
        workspace: state.context.worktree,
        nodeId: step.nodeId,
        agent: node.agent,
        step: index + 1,
        visit,
        taskId: step.taskId,
        dispatchId: step.dispatchId,
        createdAt: existing?.createdAt ?? Date.now(),
        sourceReportPath:
          existing?.sourceReportPath ??
          (step.report.reportPath !== paths.report ? step.report.reportPath : undefined),
        source: previous?.report
          ? {
              nodeId: previous.nodeId,
              taskId: previous.taskId,
              dispatchId: previous.dispatchId,
              messageId: previous.report.messageId,
              reportPath: previous.report.reportPath
            }
          : undefined,
        report: { ...step.report, reportPath: paths.report },
        route: {
          nextNodeId,
          targetType: target.type,
          dispatchedTo:
            next?.taskId && next.dispatchId
              ? { nodeId: next.nodeId, taskId: next.taskId, dispatchId: next.dispatchId }
              : undefined
        }
      })
      if (existing && reportContent(existing) !== reportContent(record)) {
        throw new Error(
          'Archived report identity or accepted content changed; inspect before recovery.'
        )
      }
      this.assertCurrent()
      writeDurableSecureJsonFile(paths.report, record)
      writeSecureFile(paths.markdown, renderWorkflowReport(record), { durable: true })
      step.report = record.report
      this.records.set(step.dispatchId, {
        record,
        report: step.report,
        recipient: next?.dispatchId
      })
    }
  }

  private async read(path: string): Promise<WorkflowReportRecord | undefined> {
    try {
      return workflowReportRecordSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined
      }
      throw error
    }
  }
}
