import { z } from 'zod'

export const documentSchema = z.object({
  document_id: z.string(),
  title: z.string(),
  path: z.string().nullable(),
  current_revision_id: z.string(),
  content: z.string(),
})
export const workspaceSchema = z.object({
  workspace_id: z.string(),
  version: z.number().int(),
  base_revision_id: z.string(),
  draft: z.string().nullable(),
  conflict: z.boolean(),
  can_update: z.boolean(),
  document: documentSchema,
  saved_revision_id: z.string().optional(),
})
export type Workspace = z.infer<typeof workspaceSchema>
export const hitsSchema = z.object({ items: z.array(documentSchema.omit({ content: true })) })
export const programHitsSchema = z.object({ output: hitsSchema })
export const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) })
export const resourceSchema = z.object({ contents: z.array(z.object({ text: z.string() })) })

export type AppAction =
  | { type: 'refresh'; workspace_id: string }
  | { type: 'checkpoint'; workspace_id: string; expected_version: number; content: string }
  | { type: 'save'; workspace_id: string; expected_version: number; operation_key: string }
  | { type: 'discard'; workspace_id: string; expected_version: number }

export type PresentArguments = { document_id: string; workspace_id?: string }
