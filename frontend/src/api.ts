import { z } from 'zod'

export const documentSchema = z.object({
  document_id: z.string(),
  title: z.string(),
  content_type: z.literal('text/markdown'),
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
  tags: z.array(z.lazy(() => tagSchema)),
  search_snippet: z.string().nullable().optional(),
})

export type Document = z.infer<typeof documentSchema>

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
  if (init?.body) headers.set('Content-Type', 'application/json')
  headers.set('X-Actor', 'human:jay')
  if (init?.method && init.method !== 'GET') headers.set('Idempotency-Key', crypto.randomUUID())
  const response = await fetch(`/api/v1${path}`, { ...init, headers })
  const payload: unknown = await response.json()
  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload)
    if (parsed.success) {
      throw new ApiError(response.status, parsed.data.error.code, parsed.data.error.message, parsed.data.error.details)
    }
    throw new ApiError(response.status, 'request_failed', `Request failed (${response.status})`, {})
  }
  return payload
}

export const api = {
  async listDocuments(): Promise<Document[]> {
    return z.array(documentSchema).parse(await request('/documents'))
  },
  async listDeletedDocuments(): Promise<Document[]> {
    const documents = z.array(documentSchema).parse(await request('/documents?include_deleted=true'))
    return documents.filter((document) => document.deleted)
  },
  async searchDocuments(
    query = '',
    tagId?: string,
    sort: 'relevance' | 'updated' | 'title' | 'path' = 'relevance',
  ): Promise<Document[]> {
    const params = new URLSearchParams()
    if (query.trim()) params.set('q', query.trim())
    if (tagId) params.set('tag_id', tagId)
    params.set('sort', sort)
    return z.array(documentSchema).parse(await request(`/search?${params.toString()}`))
  },
  async listTags(): Promise<Tag[]> {
    return z.array(tagSchema).parse(await request('/tags'))
  },
  async createTag(name: string, color: string): Promise<Tag> {
    return tagSchema.parse(
      await request('/tags', { method: 'POST', body: JSON.stringify({ name, color }) }),
    )
  },
  async listFolders(): Promise<Folder[]> {
    return z.array(folderSchema).parse(await request('/folders'))
  },
  async createFolder(path: string): Promise<Folder> {
    return folderSchema.parse(
      await request('/folders', { method: 'POST', body: JSON.stringify({ path }) }),
    )
  },
  async updateFolderMetadata(
    folder: Folder,
    category: string | null,
    tagIds: string[],
  ): Promise<Folder> {
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
  async createDocument(title: string): Promise<Document> {
    return documentSchema.parse(
      await request('/documents', {
        method: 'POST',
        body: JSON.stringify({ title, content: `# ${title}\n\n` }),
      }),
    )
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
    document: Document,
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
  async materializeDocument(document: Document, path: string): Promise<Document> {
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
  async moveDocument(document: Document, path: string): Promise<Document> {
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
  async duplicateDocument(document: Document, title?: string, path?: string): Promise<Document> {
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
  async deleteDocument(document: Document): Promise<Document> {
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
    return revisionDiffSchema.parse(
      await request(`/documents/${documentId}/diff?${params.toString()}`),
    )
  },
  async restore(document: Document, revisionId: string): Promise<Document> {
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
    const result = z.object({ indexed_documents: z.number() }).parse(
      await request('/search/reindex', { method: 'POST' }),
    )
    return result.indexed_documents
  },
  async listBackups(): Promise<BackupSet[]> {
    return z.array(backupSetSchema).parse(await request('/backups'))
  },
  async createBackup(): Promise<BackupSet> {
    return backupSetSchema.parse(await request('/backups', { method: 'POST' }))
  },
  async verifyBackup(backupId: string): Promise<z.infer<typeof backupVerificationSchema>> {
    return backupVerificationSchema.parse(
      await request(`/backups/${backupId}/verify`, { method: 'POST' }),
    )
  },
}
