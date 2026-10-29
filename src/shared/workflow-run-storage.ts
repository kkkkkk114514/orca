import { z } from 'zod'

export const workflowStorageRequestSchema = z.strictObject({
  id: z.string().uuid(),
  category: z.enum(['logs', 'artifacts', 'all']),
  confirmation: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
})
export const workflowStoragePreviewSchema = z.object({
  files: z.number().int().nonnegative(),
  bytes: z.number().nonnegative(),
  canClear: z.boolean(),
  confirmation: z.string(),
  deleted: z.number().int().nonnegative().optional(),
  errors: z.array(z.string()).max(20).optional(),
  errorCount: z.number().int().nonnegative().optional()
})
export type WorkflowStorageRequest = z.infer<typeof workflowStorageRequestSchema>
