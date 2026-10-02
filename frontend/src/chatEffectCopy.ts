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
  if (operation.kind === 'create_tag') return `Create tag "${operation.name}"`
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
  if (operation.kind === 'create_tag') return `Color ${operation.color} · not applied to anything yet`
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
  z.object({
    kind: z.literal('update_details'),
    project_id: z.string(),
    expected_version: z.number().nullable().optional(),
    name: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    brief_document_id: z.string().nullable().optional(),
    active_document_id: z.string().nullable().optional(),
    active_thread_id: z.string().nullable().optional(),
  }),
  z.object({
    kind: z.literal('update_member'),
    project_id: z.string(),
    document_id: z.string(),
    role: projectRoleSchema.nullable().optional(),
    pinned_page: z.number().nullable().optional(),
    notes: z.string().nullable().optional(),
  }),
  z.object({
    kind: z.enum(['add_thread', 'remove_thread']),
    project_id: z.string(),
    thread_id: z.string(),
  }),
  z.object({
    kind: z.enum(['add_annotation', 'remove_annotation']),
    project_id: z.string(),
    annotation_id: z.string(),
  }),
])

export type ProjectChange = z.infer<typeof projectChangeSchema>

/** Read the project change out of a pending effect's preview; null when it is not one. */
export function parseProjectChange(preview: ChatEffect['preview']): ProjectChange | null {
  const parsed = z.object({ change: projectChangeSchema }).safeParse(preview)
  return parsed.success ? parsed.data.change : null
}

export function projectChangeTitle(change: ProjectChange) {
  const project = 'project_id' in change ? shortId(change.project_id) : ''
  switch (change.kind) {
    case 'create_project':
      return `Create project "${change.name}"`
    case 'add_document':
      return `Add document ${shortId(change.document_id)} to project ${project}`
    case 'remove_document':
      return `Remove document ${shortId(change.document_id)} from project ${project}`
    case 'update_details':
      return `Update project ${project}`
    case 'update_member':
      return `Change document ${shortId(change.document_id)} in project ${project}`
    case 'add_thread':
      return `Attach conversation ${shortId(change.thread_id)} to project ${project}`
    case 'remove_thread':
      return `Detach conversation ${shortId(change.thread_id)} from project ${project}`
    case 'add_annotation':
      return `Attach annotation ${shortId(change.annotation_id)} to project ${project}`
    case 'remove_annotation':
      return `Detach annotation ${shortId(change.annotation_id)} from project ${project}`
  }
}

export function projectChangeDetail(change: ProjectChange) {
  switch (change.kind) {
    case 'create_project':
      return [change.description, change.create_brief ? 'with a purpose brief' : 'without a purpose brief']
        .filter(Boolean)
        .join(' · ')
    case 'add_document':
      return [
        `Role ${change.role}`,
        change.pinned_page ? `pinned to page ${change.pinned_page}` : null,
        change.notes ? `note: ${change.notes}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    case 'remove_document':
      return 'Membership only; the document itself is not changed'
    case 'update_details':
      return (
        [
          change.name ? `Name "${change.name}"` : null,
          change.description ? `purpose "${change.description}"` : null,
          change.brief_document_id ? `brief document ${shortId(change.brief_document_id)}` : null,
          change.active_document_id ? `active document ${shortId(change.active_document_id)}` : null,
          change.active_thread_id ? `active conversation ${shortId(change.active_thread_id)}` : null,
          change.expected_version ? `project version ${change.expected_version}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || 'No change'
      )
    case 'update_member':
      return (
        [
          change.role ? `Role ${change.role}` : null,
          change.pinned_page ? `pinned to page ${change.pinned_page}` : null,
          change.notes ? `note: ${change.notes}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || 'No change'
      )
    case 'add_thread':
      return 'The conversation appears in the project; it is not changed'
    case 'remove_thread':
      return 'Membership only; the conversation is not changed'
    case 'add_annotation':
      return 'The annotation appears in the project; it is not changed'
    case 'remove_annotation':
      return 'Membership only; the annotation itself is not changed'
  }
}

const publicationChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('unpublish'),
    publication_id: z.string(),
    expected_version: z.number(),
  }),
  z.object({
    kind: z.literal('update'),
    publication_id: z.string(),
    expected_version: z.number(),
    slug: z.string().nullable().optional(),
    access_policy: z.enum(['private', 'unlisted', 'public']).nullable().optional(),
    revision_id: z.string().nullable().optional(),
  }),
])

const annotationChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create'),
    document_id: z.string(),
    page_number: z.number(),
    annotation_type: z.enum(['comment', 'page_note', 'bookmark', 'citation_marker']),
    note: z.string().nullable().optional(),
  }),
  z.object({
    kind: z.literal('update'),
    annotation_id: z.string(),
    expected_version: z.number(),
    note: z.string().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    color: z.string().nullable().optional(),
  }),
  z.object({
    kind: z.literal('delete'),
    annotation_id: z.string(),
    expected_version: z.number(),
  }),
])

export type EffectReview = {
  eyebrow: string
  title: string
  detail: string
  approveLabel: string
}

const NOTE_LIMIT = 160
const annotationTypeLabel = {
  comment: 'comment',
  page_note: 'page note',
  bookmark: 'bookmark',
  citation_marker: 'citation marker',
} as const

/**
 * The review card text for the effects that are one exact change to one resource.
 * Returns null when the effect is not one of them or its preview is malformed, so the
 * caller can refuse to show an approval it cannot describe.
 */
export function describeEffectReview(effect: ChatEffect): EffectReview | null {
  if (effect.capability_id === 'update_project') {
    const change = parseProjectChange(effect.preview)
    return change
      ? {
          eyebrow: 'Project change',
          title: projectChangeTitle(change),
          detail: projectChangeDetail(change),
          approveLabel: 'Approve project change',
        }
      : null
  }
  if (effect.capability_id === 'update_publication') {
    const parsed = z.object({ change: publicationChangeSchema }).safeParse(effect.preview)
    if (!parsed.success) return null
    const change = parsed.data.change
    const id = shortId(change.publication_id)
    if (change.kind === 'unpublish') {
      return {
        eyebrow: 'Publication',
        title: `Withdraw publication ${id}`,
        detail: `Readers lose access at once · publication version ${change.expected_version}`,
        approveLabel: 'Approve withdrawal',
      }
    }
    return {
      eyebrow: 'Publication',
      title: `Change publication ${id}`,
      detail: [
        change.slug ? `Slug ${change.slug}` : null,
        change.access_policy ? `access ${change.access_policy}` : null,
        change.revision_id ? `publishes revision ${shortId(change.revision_id)}` : null,
        `publication version ${change.expected_version}`,
      ]
        .filter(Boolean)
        .join(' · '),
      approveLabel: 'Approve publication change',
    }
  }
  if (effect.capability_id === 'annotate_pdf') {
    const parsed = z.object({ change: annotationChangeSchema }).safeParse(effect.preview)
    if (!parsed.success) return null
    const change = parsed.data.change
    const approveLabel = 'Approve annotation change'
    if (change.kind === 'create') {
      const note = change.note ?? ''
      return {
        eyebrow: 'PDF annotation',
        title: `Add a ${annotationTypeLabel[change.annotation_type]} to page ${change.page_number} of document ${shortId(change.document_id)}`,
        detail: note.length > NOTE_LIMIT ? `${note.slice(0, NOTE_LIMIT)}…` : note || 'No note text',
        approveLabel,
      }
    }
    const id = shortId(change.annotation_id)
    if (change.kind === 'delete') {
      return {
        eyebrow: 'PDF annotation',
        title: `Delete annotation ${id}`,
        detail: `annotation version ${change.expected_version}`,
        approveLabel,
      }
    }
    return {
      eyebrow: 'PDF annotation',
      title: `Edit annotation ${id}`,
      detail: [
        change.note ? `note: ${change.note.slice(0, NOTE_LIMIT)}` : null,
        change.tags ? `tags ${change.tags.join(', ') || 'none'}` : null,
        change.color ? `color ${change.color}` : null,
        `annotation version ${change.expected_version}`,
      ]
        .filter(Boolean)
        .join(' · '),
      approveLabel,
    }
  }
  return null
}
