import { z } from 'zod'
import { chatProposalSchema } from '../api'

export const documentSchema = z.object({
  document_id: z.string(),
  title: z.string(),
  path: z.string().nullable(),
  current_revision_id: z.string(),
  content_type: z.enum(['text/markdown', 'application/pdf']),
  pdf_page_count: z.number().int().nullable().optional(),
  pdf_extraction_status: z.string().nullable().optional(),
  annotation_version: z.number().int().optional(),
  content: z.string(),
})
const textLocationSchema = z.object({
  kind: z.literal('text'),
  anchor: z.number().int(),
  head: z.number().int(),
  scroll_top: z.number(),
})
export const pdfLocationSchema = z.object({
  kind: z.literal('pdf'),
  page_number: z.number().int(),
  zoom: z.number(),
  scroll_top: z.number(),
})
export const locationSchema = z.discriminatedUnion('kind', [textLocationSchema, pdfLocationSchema])
export type PdfLocation = z.infer<typeof pdfLocationSchema>
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
  can_annotate: z.boolean(),
  document: documentSchema,
  saved_revision_id: z.string().optional(),
  proposal_version: z.string().default('0:0'),
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

export const proposalMetadataSchema = chatProposalSchema.pick({
  proposal_id: true,
  document_id: true,
  expected_revision_id: true,
  applied_revision_id: true,
  summary: true,
  status: true,
})
export const proposalPageSchema = z.object({
  items: z.array(proposalMetadataSchema),
  next_offset: z.number().int().nullable(),
})
export const proposalPassageSchema = proposalMetadataSchema
  .extend({
    content: z.string(),
    content_kind: z.enum(['proposed', 'applied']),
    current_revision_id: z.string(),
    next_offset: z.number().int().nullable(),
    sources_retrieved_truncated: z.boolean(),
  })
  .and(
    chatProposalSchema.pick({
      evidence_status: true,
      evidence: true,
      rationale: true,
      citations: true,
      sources_retrieved: true,
    }),
  )
export const revisionPassageSchema = z.object({
  content: z.string(),
  revision_id: z.string(),
  next_offset: z.number().int().nullable(),
})
export type ProposalMutationAction =
  | {
      type: 'proposal_create'
      workspace_id: string
      document_id: string
      expected_revision_id: string
      content: string
      summary: string
      operation_key: string
    }
  | {
      type: 'proposal_apply'
      workspace_id: string
      proposal_id: string
      expected_revision_id: string
      content: string
      operation_key: string
    }
  | {
      type: 'proposal_dismiss'
      workspace_id: string
      proposal_id: string
      reason: string
      operation_key: string
    }
export type ProposalAction =
  | ProposalMutationAction
  | { type: 'proposal_list'; workspace_id: string; offset: number; limit: number }
  | {
      type: 'proposal_read'
      workspace_id: string
      proposal_id: string
      offset: number
      length: number
      content_kind?: 'proposed' | 'applied'
      include_evidence?: boolean
    }
  | {
      type: 'revision_read'
      workspace_id: string
      document_id: string
      revision_id: string
      offset: number
      length: number
    }

export type AppAction =
  | ProposalAction
  | { type: 'pdf_bytes'; document_id: string; expected_revision_id: string; offset: number; length: number }
  | { type: 'pdf_page'; document_id: string; page_number: number }
  | { type: 'pdf_search'; document_id: string; query: string; offset: number; limit: number }
  | { type: 'pdf_annotations'; document_id: string; page_number: number; offset?: number; limit?: number }
  | {
      type: 'pdf_note'
      document_id: string
      page_number: number
      note: string
      selected_text: string | null
      operation_key: string
      annotation_type?: 'page_note' | 'text_highlight'
      geometry?: Array<{ x: number; y: number; width: number; height: number }>
    }
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
