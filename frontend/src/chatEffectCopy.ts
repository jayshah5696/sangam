import { z } from 'zod'
import type { ChatEffect, OrganizationOperation } from './api'

/** The IDs people read in review cards: enough to recognise, short enough to scan. */
export function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
}

export function organizationOperationTitle(operation: OrganizationOperation) {
  if (operation.kind === 'create_folder') return `Create folder ${operation.path}`
  if (operation.kind === 'materialize_document')
    return `Save draft ${shortId(operation.document_id)} to workspace`
  if (operation.kind === 'move_document') return `Move document ${shortId(operation.document_id)}`
  if (operation.kind === 'trash_document') return `Move document ${shortId(operation.document_id)} to Trash`
  if (operation.kind === 'restore_document') return `Restore document ${shortId(operation.document_id)}`
  if (operation.kind === 'duplicate_document') return `Duplicate document ${shortId(operation.document_id)}`
  if (operation.kind === 'move_folder') return `Move folder ${operation.expected_source_path}`
  if (operation.kind === 'update_document_metadata')
    return `Update document ${shortId(operation.document_id)} metadata`
  return `Update folder ${shortId(operation.folder_id)} metadata`
}

export function organizationOperationDetail(operation: OrganizationOperation) {
  if (operation.kind === 'create_folder')
    return `New path: ${operation.path} · category ${operation.category ?? 'none'} · ${operation.tag_ids.length} tags`
  if (operation.kind === 'materialize_document')
    return `New path: ${operation.destination_path} · revision ${shortId(operation.expected_revision_id)}`
  if (operation.kind === 'move_document')
    return `${operation.expected_source_path} → ${operation.destination_path} · revision ${shortId(operation.expected_revision_id)}`
  if (operation.kind === 'trash_document')
    return `${operation.expected_source_path} → Trash · revision ${shortId(operation.expected_revision_id)}`
  if (operation.kind === 'restore_document')
    return `Content of revision ${shortId(operation.revision_id)} becomes the next revision after ${shortId(operation.expected_revision_id)}`
  if (operation.kind === 'duplicate_document') {
    const destination = operation.destination_path ?? 'an unsaved draft'
    return `Copy of revision ${shortId(operation.expected_revision_id)} at ${destination}${operation.title ? ` titled "${operation.title}"` : ''}`
  }
  if (operation.kind === 'move_folder')
    return `${operation.expected_source_path} → ${operation.destination_path} · ${operation.expected_descendant_documents} descendant documents`
  return `Category ${operation.expected_category ?? 'none'} → ${operation.category ?? 'none'} · tags ${operation.expected_tag_ids.length ? operation.expected_tag_ids.join(', ') : 'none'} → ${operation.tag_ids.length ? operation.tag_ids.join(', ') : 'none'} · metadata version ${operation.expected_metadata_version}`
}

const projectRoleSchema = z.enum(['source', 'draft', 'output', 'note', 'decision'])

export const projectChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create_project'),
    name: z.string(),
    description: z.string().nullable().optional(),
    create_brief: z.boolean().optional().default(true),
  }),
  z.object({
    kind: z.literal('add_document'),
    project_id: z.string(),
    document_id: z.string(),
    role: projectRoleSchema.optional().default('source'),
    pinned_page: z.number().nullable().optional(),
    notes: z.string().nullable().optional(),
  }),
  z.object({
    kind: z.literal('remove_document'),
    project_id: z.string(),
    document_id: z.string(),
  }),
])

export type ProjectChange = z.infer<typeof projectChangeSchema>

/** Read the project change out of a pending effect's preview; null when it is not one. */
export function parseProjectChange(preview: ChatEffect['preview']): ProjectChange | null {
  const parsed = z.object({ change: projectChangeSchema }).safeParse(preview)
  return parsed.success ? parsed.data.change : null
}

export function projectChangeTitle(change: ProjectChange) {
  if (change.kind === 'create_project') return `Create project "${change.name}"`
  if (change.kind === 'add_document')
    return `Add document ${shortId(change.document_id)} to project ${shortId(change.project_id)}`
  return `Remove document ${shortId(change.document_id)} from project ${shortId(change.project_id)}`
}

export function projectChangeDetail(change: ProjectChange) {
  if (change.kind === 'create_project') {
    return [change.description, change.create_brief ? 'with a purpose brief' : 'without a purpose brief']
      .filter(Boolean)
      .join(' · ')
  }
  if (change.kind === 'add_document') {
    return [
      `Role ${change.role}`,
      change.pinned_page ? `pinned to page ${change.pinned_page}` : null,
      change.notes ? `note: ${change.notes}` : null,
    ]
      .filter(Boolean)
      .join(' · ')
  }
  return 'Membership only; the document itself is not changed'
}
