import { z } from 'zod'

export const activitySearchSchema = z.object({
  view: z.enum(['insights', 'activity']).catch('insights').default('insights'),
  range: z.enum(['all', 'today', '7d', '30d', 'custom']).catch('7d').default('7d'),
  actor_id: z.string().optional(),
  token_id: z.string().optional(),
  outcome: z.enum(['accepted', 'denied', 'conflict', 'failed']).optional().catch(undefined),
  action: z.string().optional(),
  resource_type: z.string().optional(),
  resource_id: z.string().optional(),
  path: z.string().optional(),
  error_code: z.string().optional(),
  operation_id: z.string().optional(),
  attention: z.boolean().catch(false).default(false),
  since: z.string().optional(),
  until: z.string().optional(),
  page: z.coerce.number().int().min(1).catch(1).default(1),
})

export type ActivitySearch = z.infer<typeof activitySearchSchema>
