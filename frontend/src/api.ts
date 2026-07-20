import { z } from 'zod'

export const documentSchema = z.object({
  document_id: z.string(),
  title: z.string(),
  content_type: z.enum(['text/markdown', 'text/html', 'application/pdf']),
  path: z.string().nullable(),
  current_revision_id: z.string(),
  content: z.string(),
  content_hash: z.string(),
  size_bytes: z.number(),
  materialization_state: z.enum(['none', 'pending', 'clean', 'conflict']),
  file_hash: z.string().nullable(),
  deleted: z.boolean(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  updated_by: z.string(),
  updated_by_name: z.string(),
  revision_summary: z.string().nullable(),
  category: z.string().nullable(),
  metadata_version: z.number(),
  trust_level: z.enum(['untrusted', 'trusted_interactive']),
  trust_version: z.number(),
  tags: z.array(z.lazy(() => tagSchema)),
  search_snippet: z.string().nullable().optional(),
  pdf_page_count: z.number().nullable(),
  pdf_extraction_status: z.enum(['pending', 'processing', 'ready', 'failed']).nullable(),
  pdf_extraction_error: z.string().nullable(),
  supersedes_document_id: z.string().nullable(),
})

export type Document = z.infer<typeof documentSchema>

export const documentSummarySchema = documentSchema.omit({ content: true })

export type DocumentSummary = z.infer<typeof documentSummarySchema>

export const karakeepAssetSchema = z.object({
  asset_id: z.string(),
  asset_type: z.string(),
  file_name: z.string().nullable(),
})

export const karakeepBookmarkSchema = z.object({
  bookmark_id: z.string(),
  title: z.string(),
  content_type: z.enum(['link', 'text', 'asset', 'unknown']),
  source_url: z.string().nullable(),
  author: z.string().nullable(),
  created_at: z.string(),
  modified_at: z.string().nullable(),
  tags: z.array(z.string()),
  assets: z.array(karakeepAssetSchema),
  imported_document_id: z.string().nullable(),
  import_status: z.string().nullable(),
})

export type KarakeepBookmark = z.infer<typeof karakeepBookmarkSchema>

export const karakeepBookmarkPageSchema = z.object({
  bookmarks: z.array(karakeepBookmarkSchema),
  next_cursor: z.string().nullable(),
})

export const karakeepConnectionSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  message: z.string(),
})

export const karakeepImportSchema = z.object({
  import_id: z.string(),
  bookmark_id: z.string(),
  document_id: z.string().nullable(),
  status: z.enum(['importing', 'current', 'review_required', 'failed']),
  last_error: z.string().nullable(),
  last_attempt_at: z.string(),
  last_success_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  source_url: z.string().nullable(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  source_created_at: z.string().nullable(),
  source_modified_at: z.string().nullable(),
  tags: z.array(z.string()),
  assets: z.array(karakeepAssetSchema),
})

export type KarakeepImport = z.infer<typeof karakeepImportSchema>

export const karakeepImportDetailSchema = karakeepImportSchema.extend({
  document_title: z.string().nullable(),
  current_revision_id: z.string().nullable(),
  working_copy: z.string().nullable(),
  accepted_markdown: z.string().nullable(),
  pending_markdown: z.string().nullable(),
})

export type KarakeepImportDetail = z.infer<typeof karakeepImportDetailSchema>

export const tagSchema = z.object({
  tag_id: z.string(),
  name: z.string(),
  color: z.string(),
  created_at: z.string(),
})

export type Tag = z.infer<typeof tagSchema>

export const folderSchema = z.object({
  folder_id: z.string(),
  path: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  metadata_version: z.number(),
  tags: z.array(tagSchema),
  document_count: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
})

export type Folder = z.infer<typeof folderSchema>

export const revisionSchema = z.object({
  revision_id: z.string(),
  document_id: z.string(),
  parent_revision_id: z.string().nullable(),
  content: z.string(),
  content_hash: z.string(),
  size_bytes: z.number(),
  actor_id: z.string(),
  actor_display_name: z.string().nullable(),
  actor_kind: z.string().nullable(),
  operation_id: z.string().nullable(),
  operation: z.string(),
  summary: z.string().nullable(),
  created_at: z.string(),
})

export type Revision = z.infer<typeof revisionSchema>

export const revisionDiffSchema = z.object({
  document_id: z.string(),
  from_revision_id: z.string(),
  to_revision_id: z.string(),
  unified_diff: z.string(),
  additions: z.number(),
  deletions: z.number(),
})

export type RevisionDiff = z.infer<typeof revisionDiffSchema>

export const reconciliationConflictSchema = z.object({
  conflict_id: z.string(),
  conflict_type: z.enum(['unexpected_hash', 'possible_move', 'unknown_file']),
  document_id: z.string().nullable(),
  path: z.string(),
  candidate_path: z.string().nullable(),
  expected_hash: z.string().nullable(),
  actual_hash: z.string().nullable(),
  status: z.string(),
  created_at: z.string(),
  resolved_at: z.string().nullable(),
})

export type ReconciliationConflict = z.infer<typeof reconciliationConflictSchema>

export const reconciliationReportSchema = z.object({
  repaired_document_ids: z.array(z.string()),
  conflicts: z.array(reconciliationConflictSchema),
})

export const backupSetSchema = z.object({
  backup_id: z.string(),
  created_at: z.string(),
  document_count: z.number(),
  revision_count: z.number(),
  artifacts: z.array(z.object({ name: z.string(), sha256: z.string(), size_bytes: z.number() })),
  verified_at: z.string().nullable(),
})

export type BackupSet = z.infer<typeof backupSetSchema>

export const tokenScopeSchema = z.object({
  capability: z.enum(['read', 'search', 'create', 'update', 'move', 'tag', 'restore', 'delete', 'publish']),
  path_prefix: z.string().nullable(),
})

export type TokenScope = z.infer<typeof tokenScopeSchema>

export const agentTokenSchema = z.object({
  token_id: z.string(),
  actor_id: z.string(),
  actor_display_name: z.string(),
  label: z.string(),
  scopes: z.array(tokenScopeSchema),
  created_at: z.string(),
  expires_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  last_used_at: z.string().nullable(),
  rotated_from_token_id: z.string().nullable(),
})

export type AgentToken = z.infer<typeof agentTokenSchema>

export const issuedAgentTokenSchema = agentTokenSchema.extend({ token: z.string() })

export type IssuedAgentToken = z.infer<typeof issuedAgentTokenSchema>

export const operationEventSchema = z.object({
  operation_id: z.string(),
  actor_id: z.string(),
  actor_display_name: z.string(),
  actor_kind: z.string(),
  token_id: z.string().nullable(),
  token_label: z.string().nullable(),
  action: z.string(),
  resource_type: z.string(),
  resource_id: z.string().nullable(),
  path: z.string().nullable(),
  outcome: z.enum(['accepted', 'denied', 'conflict', 'failed']),
  error_code: z.string().nullable(),
  revision_id: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  created_at: z.string(),
})

export type OperationEvent = z.infer<typeof operationEventSchema>

export const publicationSchema = z.object({
  publication_id: z.string(),
  document_id: z.string(),
  document_title: z.string(),
  slug: z.string(),
  access_policy: z.enum(['private', 'public', 'unlisted']),
  version: z.number(),
  active: z.boolean(),
  has_active_token: z.boolean(),
  created_by: z.string(),
  updated_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  url: z.string(),
})

export type Publication = z.infer<typeof publicationSchema>

export const issuedPublicationSchema = publicationSchema.extend({ token: z.string().nullable() })
export type IssuedPublication = z.infer<typeof issuedPublicationSchema>

export const publicationContentSchema = z.object({
  publication_id: z.string(),
  document_id: z.string(),
  title: z.string(),
  slug: z.string(),
  revision_id: z.string(),
  content_type: z.enum(['text/markdown', 'text/html']),
  content: z.string(),
  trust_level: z.enum(['untrusted', 'trusted_interactive']),
  is_latest: z.boolean(),
  asset_base_url: z.string(),
})

export type PublicationContent = z.infer<typeof publicationContentSchema>

export const trustedPreviewGrantSchema = z.object({
  url: z.string(),
  token: z.string(),
  expires_at: z.string(),
})

export type TrustedPreviewGrant = z.infer<typeof trustedPreviewGrantSchema>

export const pdfRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})

export type PdfRect = z.infer<typeof pdfRectSchema>

export const pdfPageSchema = z.object({
  document_id: z.string(),
  page_number: z.number(),
  text: z.string(),
})

export const pdfSearchResultSchema = pdfPageSchema.extend({ snippet: z.string() })
export type PdfSearchResult = z.infer<typeof pdfSearchResultSchema>

export const annotationSchema = z.object({
  annotation_id: z.string(),
  document_id: z.string(),
  page_number: z.number(),
  annotation_type: z.enum([
    'text_highlight',
    'area_highlight',
    'comment',
    'page_note',
    'bookmark',
    'citation_marker',
  ]),
  selected_text: z.string().nullable(),
  note: z.string().nullable(),
  geometry: z.array(pdfRectSchema),
  tags: z.array(z.string()),
  color: z.string(),
  version: z.number(),
  deleted: z.boolean(),
  created_by: z.string(),
  created_by_name: z.string(),
  updated_by: z.string(),
  updated_by_name: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
})

export type Annotation = z.infer<typeof annotationSchema>

export const annotationEventSchema = z.object({
  event_id: z.string(),
  annotation_id: z.string(),
  document_id: z.string(),
  actor_id: z.string(),
  actor_display_name: z.string(),
  actor_kind: z.string(),
  operation: z.enum(['create', 'update', 'delete']),
  version: z.number(),
  snapshot: z.record(z.string(), z.unknown()),
  created_at: z.string(),
})

export type AnnotationEvent = z.infer<typeof annotationEventSchema>

export const chatRuntimeConfigSchema = z.object({
  configured: z.boolean(),
  provider: z.literal('openrouter_openai_agents'),
  transport: z.literal('chatkit'),
  domain_key: z.string(),
  default_model: z.string(),
  available_models: z.array(z.string()),
  reasoning_effort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']),
})

export type ChatRuntimeConfig = z.infer<typeof chatRuntimeConfigSchema>

export const chatModelInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  enabled: z.boolean(),
})

export const chatModelSettingsSchema = z.object({
  openrouter_configured: z.boolean(),
  openrouter_enabled: z.boolean(),
  default_model: z.string(),
  enabled_models: z.array(z.string()),
  catalog: z.array(chatModelInfoSchema),
  catalog_fetched_at: z.string().nullable(),
})

export type ChatModelInfo = z.infer<typeof chatModelInfoSchema>
export type ChatModelSettings = z.infer<typeof chatModelSettingsSchema>

export type ChatModelSelectionUpdate = {
  openrouter_enabled: boolean
  default_model: string
  enabled_models: string[]
}

export const chatProposalSchema = z.object({
  proposal_id: z.string(),
  thread_id: z.string(),
  document_id: z.string(),
  expected_revision_id: z.string(),
  content: z.string(),
  summary: z.string().nullable(),
  status: z.enum(['pending', 'applied', 'stale', 'dismissed']),
  applied_revision_id: z.string().nullable(),
  created_at: z.string(),
  applied_at: z.string().nullable(),
})

export type ChatProposal = z.infer<typeof chatProposalSchema>

export const backupVerificationSchema = z.object({
  backup_id: z.string(),
  valid: z.boolean(),
  database_integrity: z.string(),
  workspace_members: z.number(),
  verified_at: z.string(),
})

const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()),
  }),
})

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(status: number, code: string, message: string, details: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (init?.method && init.method !== 'GET' && !headers.has('Idempotency-Key')) {
    headers.set('Idempotency-Key', crypto.randomUUID())
  }
  const response = await fetch(`/api/v1${path}`, { ...init, headers })
  const payload: unknown = await response.json()
  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload)
    if (parsed.success) {
      throw new ApiError(
        response.status,
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.details,
      )
    }
    throw new ApiError(response.status, 'request_failed', `Request failed (${response.status})`, {})
  }
  return payload
}

const PAGE_SIZE = 200
const MAX_PAGES = 50

export async function collectPages<T>(
  loadPage: (offset: number, limit: number) => Promise<T[]>,
  pageSize = PAGE_SIZE,
  maxPages = MAX_PAGES,
): Promise<T[]> {
  if (pageSize < 1 || maxPages < 1) throw new Error('Pagination bounds must be positive')
  const items: T[] = []
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await loadPage(pageIndex * pageSize, pageSize)
    items.push(...page)
    if (page.length < pageSize) return items
  }
  throw new Error(`Pagination exceeded the safety limit of ${maxPages * pageSize} items`)
}

export const api = {
  async chatConfig(): Promise<ChatRuntimeConfig> {
    return chatRuntimeConfigSchema.parse(await request('/chat/config'))
  },
  async chatModels(): Promise<ChatModelSettings> {
    return chatModelSettingsSchema.parse(await request('/chat/models'))
  },
  async updateChatModels(selection: ChatModelSelectionUpdate): Promise<ChatModelSettings> {
    return chatModelSettingsSchema.parse(
      await request('/chat/models', {
        method: 'PUT',
        body: JSON.stringify(selection),
      }),
    )
  },
  async refreshChatModels(): Promise<ChatModelSettings> {
    return chatModelSettingsSchema.parse(await request('/chat/models/refresh', { method: 'POST' }))
  },
  async listChatProposals(documentId: string, threadId?: string): Promise<ChatProposal[]> {
    const params = new URLSearchParams({ document_id: documentId })
    if (threadId) params.set('thread_id', threadId)
    return z.array(chatProposalSchema).parse(await request(`/chat/proposals?${params.toString()}`))
  },
  async applyChatProposal(proposal: ChatProposal): Promise<ChatProposal> {
    return chatProposalSchema.parse(
      await request(`/chat/proposals/${proposal.proposal_id}/apply`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `chat-proposal:${proposal.proposal_id}` },
        body: JSON.stringify({ expected_revision_id: proposal.expected_revision_id }),
      }),
    )
  },
  async dismissChatProposal(proposalId: string, reason?: string): Promise<ChatProposal> {
    const trimmed = reason?.trim()
    return chatProposalSchema.parse(
      await request(`/chat/proposals/${proposalId}/dismiss`, {
        method: 'POST',
        body: JSON.stringify({ reason: trimmed ? trimmed.slice(0, 500) : null }),
      }),
    )
  },
  async karakeepHealth(): Promise<z.infer<typeof karakeepConnectionSchema>> {
    return karakeepConnectionSchema.parse(await request('/karakeep/health'))
  },
  async searchKarakeep(query: string, cursor?: string): Promise<z.infer<typeof karakeepBookmarkPageSchema>> {
    const params = new URLSearchParams({ q: query, limit: '30' })
    if (cursor) params.set('cursor', cursor)
    return karakeepBookmarkPageSchema.parse(await request(`/karakeep/bookmarks?${params.toString()}`))
  },
  async listKarakeepImports(): Promise<KarakeepImport[]> {
    return z.array(karakeepImportSchema).parse(await request('/karakeep/imports'))
  },
  async getKarakeepImport(importId: string): Promise<KarakeepImportDetail> {
    return karakeepImportDetailSchema.parse(await request(`/karakeep/imports/${importId}`))
  },
  async importKarakeepBookmark(bookmarkId: string): Promise<KarakeepImportDetail> {
    return karakeepImportDetailSchema.parse(
      await request('/karakeep/imports', {
        method: 'POST',
        body: JSON.stringify({ bookmark_id: bookmarkId }),
      }),
    )
  },
  async refreshKarakeepImport(importId: string): Promise<KarakeepImportDetail> {
    return karakeepImportDetailSchema.parse(
      await request(`/karakeep/imports/${importId}/refresh`, { method: 'POST' }),
    )
  },
  async applyKarakeepRefresh(detail: KarakeepImportDetail, content: string): Promise<KarakeepImportDetail> {
    if (!detail.current_revision_id) throw new Error('The imported document has no current revision')
    return karakeepImportDetailSchema.parse(
      await request(`/karakeep/imports/${detail.import_id}/apply`, {
        method: 'POST',
        body: JSON.stringify({ expected_revision_id: detail.current_revision_id, content }),
      }),
    )
  },
  async listAgentTokens(): Promise<AgentToken[]> {
    return z.array(agentTokenSchema).parse(await request('/agent-tokens'))
  },
  async issueAgentToken(input: {
    actor_id: string
    display_name: string
    label: string
    scopes: TokenScope[]
    expires_at?: string | null
  }): Promise<IssuedAgentToken> {
    return issuedAgentTokenSchema.parse(
      await request('/agent-tokens', { method: 'POST', body: JSON.stringify(input) }),
    )
  },
  async rotateAgentToken(tokenId: string): Promise<IssuedAgentToken> {
    return issuedAgentTokenSchema.parse(await request(`/agent-tokens/${tokenId}/rotate`, { method: 'POST' }))
  },
  async revokeAgentToken(tokenId: string): Promise<AgentToken> {
    return agentTokenSchema.parse(await request(`/agent-tokens/${tokenId}`, { method: 'DELETE' }))
  },
  async listActivity(actorId?: string, outcome?: OperationEvent['outcome']): Promise<OperationEvent[]> {
    const params = new URLSearchParams({ limit: '100' })
    if (actorId) params.set('actor_id', actorId)
    if (outcome) params.set('outcome', outcome)
    return z.array(operationEventSchema).parse(await request(`/activity?${params.toString()}`))
  },
  async listDocuments(): Promise<DocumentSummary[]> {
    return collectPages(async (offset, limit) =>
      z.array(documentSummarySchema).parse(await request(`/documents?limit=${limit}&offset=${offset}`)),
    )
  },
  async listDeletedDocuments(): Promise<DocumentSummary[]> {
    const documents = await collectPages(async (offset, limit) =>
      z
        .array(documentSummarySchema)
        .parse(await request(`/documents?include_deleted=true&limit=${limit}&offset=${offset}`)),
    )
    return documents.filter((document) => document.deleted)
  },
  async searchDocuments(
    query = '',
    tagId?: string,
    sort: 'relevance' | 'updated' | 'title' | 'path' = 'relevance',
  ): Promise<DocumentSummary[]> {
    const params = new URLSearchParams()
    if (query.trim()) params.set('q', query.trim())
    if (tagId) params.set('tag_id', tagId)
    params.set('sort', sort)
    return collectPages(async (offset, limit) => {
      const pageParams = new URLSearchParams(params)
      pageParams.set('limit', String(limit))
      pageParams.set('offset', String(offset))
      return z.array(documentSummarySchema).parse(await request(`/search?${pageParams.toString()}`))
    })
  },
  async listTags(): Promise<Tag[]> {
    return z.array(tagSchema).parse(await request('/tags'))
  },
  async createTag(name: string, color: string): Promise<Tag> {
    return tagSchema.parse(await request('/tags', { method: 'POST', body: JSON.stringify({ name, color }) }))
  },
  async listFolders(): Promise<Folder[]> {
    return z.array(folderSchema).parse(await request('/folders'))
  },
  async createFolder(path: string): Promise<Folder> {
    return folderSchema.parse(await request('/folders', { method: 'POST', body: JSON.stringify({ path }) }))
  },
  async updateFolderMetadata(folder: Folder, category: string | null, tagIds: string[]): Promise<Folder> {
    return folderSchema.parse(
      await request(`/folders/${folder.folder_id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          expected_metadata_version: folder.metadata_version,
          category,
          tag_ids: tagIds,
        }),
      }),
    )
  },
  async getDocument(documentId: string): Promise<Document> {
    return documentSchema.parse(await request(`/documents/${documentId}`))
  },
  async createDocument(
    title: string,
    path?: string,
    contentType: Document['content_type'] = 'text/markdown',
  ): Promise<Document> {
    const content =
      contentType === 'text/html'
        ? `<!doctype html>\n<html>\n  <head><title>${title}</title></head>\n  <body>\n    <h1>${title}</h1>\n  </body>\n</html>\n`
        : `# ${title}\n\n`
    return documentSchema.parse(
      await request('/documents', {
        method: 'POST',
        body: JSON.stringify({ title, content, path, content_type: contentType }),
      }),
    )
  },
  async importPdf(file: File, title: string, path: string, supersedesDocumentId?: string): Promise<Document> {
    const params = new URLSearchParams({ title, path })
    if (supersedesDocumentId) params.set('supersedes_document_id', supersedesDocumentId)
    return documentSchema.parse(
      await request(`/pdfs?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: file,
      }),
    )
  },
  pdfContentUrl(documentId: string): string {
    return `/api/v1/pdfs/${encodeURIComponent(documentId)}/content`
  },
  async pdfPages(documentId: string): Promise<z.infer<typeof pdfPageSchema>[]> {
    return z.array(pdfPageSchema).parse(await request(`/pdfs/${documentId}/pages`))
  },
  async searchPdf(documentId: string, query: string): Promise<PdfSearchResult[]> {
    return z
      .array(pdfSearchResultSchema)
      .parse(await request(`/pdfs/${documentId}/search?${new URLSearchParams({ q: query })}`))
  },
  async retryPdfExtraction(documentId: string): Promise<Document> {
    return documentSchema.parse(await request(`/pdfs/${documentId}/extract`, { method: 'POST' }))
  },
  async listAnnotations(documentId: string, query = '', includeDeleted = false): Promise<Annotation[]> {
    const params = new URLSearchParams()
    if (query) params.set('q', query)
    if (includeDeleted) params.set('include_deleted', 'true')
    const suffix = params.size ? `?${params.toString()}` : ''
    return z.array(annotationSchema).parse(await request(`/pdfs/${documentId}/annotations${suffix}`))
  },
  async createAnnotation(
    documentId: string,
    input: {
      page_number: number
      annotation_type: Annotation['annotation_type']
      selected_text?: string | null
      note?: string | null
      geometry?: PdfRect[]
      tags?: string[]
      color?: string
    },
  ): Promise<Annotation> {
    return annotationSchema.parse(
      await request(`/pdfs/${documentId}/annotations`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    )
  },
  async updateAnnotation(
    annotation: Annotation,
    input: Pick<Annotation, 'selected_text' | 'note' | 'geometry' | 'tags' | 'color'>,
  ): Promise<Annotation> {
    return annotationSchema.parse(
      await request(`/annotations/${annotation.annotation_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ expected_version: annotation.version, ...input }),
      }),
    )
  },
  async deleteAnnotation(annotation: Annotation): Promise<Annotation> {
    return annotationSchema.parse(
      await request(`/annotations/${annotation.annotation_id}?expected_version=${annotation.version}`, {
        method: 'DELETE',
      }),
    )
  },
  async annotationHistory(annotationId: string): Promise<AnnotationEvent[]> {
    return z.array(annotationEventSchema).parse(await request(`/annotations/${annotationId}/history`))
  },
  async updateDocumentTrust(document: Document, trustLevel: Document['trust_level']): Promise<Document> {
    return documentSchema.parse(
      await request(`/documents/${document.document_id}/trust`, {
        method: 'PATCH',
        body: JSON.stringify({
          expected_trust_version: document.trust_version,
          trust_level: trustLevel,
        }),
      }),
    )
  },
  async issueTrustedPreview(document: Document, revisionId: string): Promise<TrustedPreviewGrant> {
    const params = new URLSearchParams({ revision_id: revisionId })
    return trustedPreviewGrantSchema.parse(
      await request(`/documents/${document.document_id}/trusted-preview?${params.toString()}`, {
        method: 'POST',
      }),
    )
  },
  async getDocumentPublication(documentId: string): Promise<Publication | null> {
    return publicationSchema.nullable().parse(await request(`/publications/by-document/${documentId}`))
  },
  async createPublication(
    documentId: string,
    slug: string,
    accessPolicy: Publication['access_policy'],
  ): Promise<IssuedPublication> {
    return issuedPublicationSchema.parse(
      await request('/publications', {
        method: 'POST',
        body: JSON.stringify({ document_id: documentId, slug, access_policy: accessPolicy }),
      }),
    )
  },
  async updatePublication(
    publication: Publication,
    slug: string,
    accessPolicy: Publication['access_policy'],
  ): Promise<IssuedPublication> {
    return issuedPublicationSchema.parse(
      await request(`/publications/${publication.publication_id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          expected_version: publication.version,
          slug,
          access_policy: accessPolicy,
        }),
      }),
    )
  },
  async unpublish(publication: Publication): Promise<Publication> {
    return publicationSchema.parse(
      await request(`/publications/${publication.publication_id}?expected_version=${publication.version}`, {
        method: 'DELETE',
      }),
    )
  },
  async exposePublicationRevision(publicationId: string, revisionId: string): Promise<void> {
    await request(`/publications/${publicationId}/revisions`, {
      method: 'POST',
      body: JSON.stringify({ revision_id: revisionId }),
    })
  },
  async rotatePublicationToken(publicationId: string): Promise<IssuedPublication> {
    return issuedPublicationSchema.parse(
      await request(`/publications/${publicationId}/rotate-token`, { method: 'POST' }),
    )
  },
  async getPublicationContent(slug: string, revision?: string, token?: string): Promise<PublicationContent> {
    const params = new URLSearchParams()
    if (revision) params.set('revision', revision)
    const query = params.size ? `?${params.toString()}` : ''
    return publicationContentSchema.parse(
      await request(`/publications/${encodeURIComponent(slug)}/content${query}`, {
        headers: token ? { Authorization: `Sangam-Publication ${token}` } : undefined,
      }),
    )
  },
  async publicationAsset(url: string, reference: string, token?: string): Promise<string> {
    const response = await fetch(`${url}${encodeURIComponent(reference)}`, {
      headers: token ? { Authorization: `Sangam-Publication ${token}` } : undefined,
    })
    if (!response.ok) throw new Error('Publication asset could not be loaded')
    return URL.createObjectURL(await response.blob())
  },
  async updateDocument(document: Document, content: string, title?: string): Promise<Document> {
    return documentSchema.parse(
      await request(`/documents/${document.document_id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          expected_revision_id: document.current_revision_id,
          content,
          title,
          summary: 'Browser autosave',
        }),
      }),
    )
  },
  async updateDocumentMetadata(
    document: DocumentSummary,
    category: string | null,
    tagIds: string[],
  ): Promise<Document> {
    return documentSchema.parse(
      await request(`/documents/${document.document_id}/metadata`, {
        method: 'PATCH',
        body: JSON.stringify({
          expected_metadata_version: document.metadata_version,
          category,
          tag_ids: tagIds,
        }),
      }),
    )
  },
  async materializeDocument(document: DocumentSummary, path: string): Promise<Document> {
    return documentSchema.parse(
      await request(`/documents/${document.document_id}/materialize`, {
        method: 'POST',
        body: JSON.stringify({
          expected_revision_id: document.current_revision_id,
          path,
          summary: 'Saved to workspace',
        }),
      }),
    )
  },
  async moveDocument(document: DocumentSummary, path: string): Promise<Document> {
    return documentSchema.parse(
      await request(`/documents/${document.document_id}/move`, {
        method: 'POST',
        body: JSON.stringify({
          expected_revision_id: document.current_revision_id,
          path,
          summary: `Moved to ${path}`,
        }),
      }),
    )
  },
  async duplicateDocument(document: DocumentSummary, title?: string, path?: string): Promise<Document> {
    return documentSchema.parse(
      await request(`/documents/${document.document_id}/duplicate`, {
        method: 'POST',
        body: JSON.stringify({
          expected_revision_id: document.current_revision_id,
          title,
          path,
        }),
      }),
    )
  },
  async deleteDocument(document: DocumentSummary): Promise<Document> {
    return documentSchema.parse(
      await request(`/documents/${document.document_id}`, {
        method: 'DELETE',
        body: JSON.stringify({
          expected_revision_id: document.current_revision_id,
          summary: 'Moved to trash from browser',
        }),
      }),
    )
  },
  async history(documentId: string): Promise<Revision[]> {
    return z.array(revisionSchema).parse(await request(`/documents/${documentId}/history`))
  },
  async revisionDiff(
    documentId: string,
    fromRevisionId: string,
    toRevisionId?: string,
  ): Promise<RevisionDiff> {
    const params = new URLSearchParams({ from_revision_id: fromRevisionId })
    if (toRevisionId) params.set('to_revision_id', toRevisionId)
    return revisionDiffSchema.parse(await request(`/documents/${documentId}/diff?${params.toString()}`))
  },
  async restore(document: DocumentSummary, revisionId: string): Promise<Document> {
    return documentSchema.parse(
      await request(`/documents/${document.document_id}/restore`, {
        method: 'POST',
        body: JSON.stringify({
          expected_revision_id: document.current_revision_id,
          revision_id: revisionId,
        }),
      }),
    )
  },
  async reconciliation(): Promise<z.infer<typeof reconciliationReportSchema>> {
    return reconciliationReportSchema.parse(await request('/reconciliation'))
  },
  async scanWorkspace(): Promise<z.infer<typeof reconciliationReportSchema>> {
    return reconciliationReportSchema.parse(await request('/reconciliation/scan', { method: 'POST' }))
  },
  async importUnknown(path: string): Promise<Document> {
    return documentSchema.parse(
      await request('/reconciliation/reindex', {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
    )
  },
  async acceptDisk(conflictId: string): Promise<Document> {
    return documentSchema.parse(
      await request(`/reconciliation/${conflictId}/accept-disk`, { method: 'POST' }),
    )
  },
  async restoreDatabase(conflictId: string): Promise<Document> {
    return documentSchema.parse(
      await request(`/reconciliation/${conflictId}/restore-database`, { method: 'POST' }),
    )
  },
  async recognizeMove(conflictId: string): Promise<Document> {
    return documentSchema.parse(
      await request(`/reconciliation/${conflictId}/recognize-move`, { method: 'POST' }),
    )
  },
  async ignoreUnknown(conflictId: string): Promise<z.infer<typeof reconciliationReportSchema>> {
    return reconciliationReportSchema.parse(
      await request(`/reconciliation/${conflictId}/ignore`, { method: 'POST' }),
    )
  },
  async rebuildSearch(): Promise<number> {
    const result = z
      .object({ indexed_documents: z.number() })
      .parse(await request('/search/reindex', { method: 'POST' }))
    return result.indexed_documents
  },
  async listBackups(): Promise<BackupSet[]> {
    return z.array(backupSetSchema).parse(await request('/backups'))
  },
  async createBackup(): Promise<BackupSet> {
    return backupSetSchema.parse(await request('/backups', { method: 'POST' }))
  },
  async verifyBackup(backupId: string): Promise<z.infer<typeof backupVerificationSchema>> {
    return backupVerificationSchema.parse(await request(`/backups/${backupId}/verify`, { method: 'POST' }))
  },
}
