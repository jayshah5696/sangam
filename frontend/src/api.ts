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
  category: z.string().nullable(),
  metadata_version: z.number(),
  tags: z.array(z.lazy(() => tagSchema)),
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
  async searchDocuments(query = '', tagId?: string): Promise<Document[]> {
    const params = new URLSearchParams()
    if (query.trim()) params.set('q', query.trim())
    if (tagId) params.set('tag_id', tagId)
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
  async updateDocument(document: Document, content: string): Promise<Document> {
    return documentSchema.parse(
      await request(`/documents/${document.document_id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          expected_revision_id: document.current_revision_id,
          content,
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
  async history(documentId: string): Promise<Revision[]> {
    return z.array(revisionSchema).parse(await request(`/documents/${documentId}/history`))
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
}
