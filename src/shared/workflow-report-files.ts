import { z } from 'zod'

export const WORKFLOW_REPORT_MAX_FILES = 1000
export const WORKFLOW_REPORT_FILES_MAX_BYTES = 64 * 1024

export const workflowReportFilesSchema = z
  .array(z.string().min(1).max(4096))
  .max(WORKFLOW_REPORT_MAX_FILES)
  .refine(
    (files) =>
      new TextEncoder().encode(JSON.stringify(files)).byteLength <= WORKFLOW_REPORT_FILES_MAX_BYTES,
    'Modified file paths exceed the 64 KiB report budget; provide a manifest path in the report body.'
  )
