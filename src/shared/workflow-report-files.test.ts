import { expect, it } from 'vitest'
import { workflowStepReportSchema } from './workflow-execution'
import { workflowReportFilesSchema, WORKFLOW_REPORT_MAX_FILES } from './workflow-report-files'

it('round-trips a report with more than 20 paths through the checkpoint contract without losing files', () => {
  const report = {
    outcome: 'succeeded',
    messageId: 'msg_actual',
    body: 'Verified work',
    filesModified: Array.from({ length: 22 }, (_, index) => `src/file-${index}.js`)
  }
  const saved = JSON.parse(JSON.stringify(workflowStepReportSchema.parse(report)))
  expect(workflowStepReportSchema.parse(saved)).toEqual(report)
})

it('bounds the number, path length and serialized UTF-8 size without truncating accepted lists', () => {
  expect(
    workflowReportFilesSchema.safeParse(
      Array.from({ length: WORKFLOW_REPORT_MAX_FILES + 1 }, () => 'a')
    ).success
  ).toBe(false)
  expect(workflowReportFilesSchema.safeParse(['a'.repeat(4097)]).success).toBe(false)
  expect(
    workflowReportFilesSchema.safeParse(Array.from({ length: 20 }, () => '开发'.repeat(1000)))
      .success
  ).toBe(false)
  expect(workflowReportFilesSchema.parse(['src/a.js', 'src/b.js'])).toEqual([
    'src/a.js',
    'src/b.js'
  ])
})
