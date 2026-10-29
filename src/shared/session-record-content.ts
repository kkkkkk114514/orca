import { z } from 'zod'

export const sessionRecordBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool-call'),
    name: z.string().max(256),
    input: z.json().default(null),
    callId: z.string().max(512).optional(),
    state: z.enum(['running', 'completed', 'failed']).optional(),
    endedAs: z.enum(['interrupted', 'unverifiable']).optional()
  }),
  z.object({
    type: z.literal('tool-result'),
    output: z.string(),
    isError: z.boolean().optional(),
    callId: z.string().max(512).optional(),
    editPatch: z
      .object({
        filePath: z.string().optional(),
        hunks: z.array(
          z.object({
            oldStart: z.number(),
            oldLines: z.number(),
            newStart: z.number(),
            newLines: z.number(),
            lines: z.array(z.string())
          })
        )
      })
      .optional()
  })
])
