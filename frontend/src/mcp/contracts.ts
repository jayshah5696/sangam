import { z } from 'zod'

export const documentSchema = z.object({
  document_id: z.string(),
  title: z.string(),
  path: z.string().nullable(),
  current_revision_id: z.string(),
  content: z.string(),
})
export const locationSchema = z.object({
  kind: z.literal('text'),
  anchor: z.number().int(),
  head: z.number().int(),
  scroll_top: z.number(),
})
export type ViewLocation = z.infer<typeof locationSchema>
const documentViewSchema = z.object({
  workspace_id: z.string(),
  version: z.number().int(),
  view_version: z.number().int(),
  location: locationSchema,
  base_revision_id: z.string(),
  draft: z.string().nullable(),
  conflict: z.boolean(),
  can_update: z.boolean(),
  document: documentSchema,
  saved_revision_id: z.string().optional(),
})
export const workspaceSchema = documentViewSchema.extend({
  comparison: documentViewSchema.nullable(),
  layout: z.object({
    layout_id: z.string(),
    version: z.number().int(),
    active_workspace_id: z.string(),
    unavailable_count: z.number().int(),
    comparison_workspace_id: z.string().nullable(),
    tabs: z.array(
      z.object({
        workspace_id: z.string(),
        document_id: z.string(),
        title: z.string(),
        path: z.string().nullable(),
        has_draft: z.boolean(),
      }),
    ),
  }),
})
export type Workspace = z.infer<typeof workspaceSchema>
export const hitsSchema = z.object({
  items: z.array(documentSchema.omit({ content: true })),
  next_offset: z.number().int().nullable(),
})
export type SearchResults = z.infer<typeof hitsSchema>
export const programHitsSchema = z.object({ output: hitsSchema })
export const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) })
export const resourceSchema = z.object({ contents: z.array(z.object({ text: z.string() })) })

export type AppAction =
  | {
      type: 'compare'
      workspace_id: string
      expected_layout_version: number
      target_workspace_id: string | null
    }
  | { type: 'view'; workspace_id: string; expected_view_version: number; location: ViewLocation }
  | { type: 'refresh'; workspace_id: string }
  | { type: 'checkpoint'; workspace_id: string; expected_version: number; content: string }
  | { type: 'save'; workspace_id: string; expected_version: number; operation_key: string }
  | { type: 'discard'; workspace_id: string; expected_version: number }
  | { type: 'search'; query: string; limit: number; offset: number }
  | { type: 'open'; workspace_id: string; document_id: string; expected_layout_version: number }
  | {
      type: 'activate' | 'close'
      workspace_id: string
      target_workspace_id: string
      expected_layout_version: number
    }

export type PresentArguments = { document_id: string; workspace_id?: string } | { layout_id: string }
