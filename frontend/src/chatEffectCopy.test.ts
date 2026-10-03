import { describe, expect, it } from 'vitest'
import type { ChatEffect, OrganizationOperation } from './api'
import {
  describeEffectReview,
  organizationOperationDetail,
  organizationOperationTitle,
  parseProjectChange,
  projectChangeDetail,
  projectChangeTitle,
} from './chatEffectCopy'

describe('organization plan copy', () => {
  it('shows the revision a restore starts from and the one it restores', () => {
    const operation: OrganizationOperation = {
      kind: 'restore_document',
      document_id: 'doc-aaaa-bbbb-cccc',
      expected_revision_id: 'rev-current-0001',
      revision_id: 'rev-earlier-0009',
    }
    expect(organizationOperationTitle(operation)).toBe('Restore document doc-aaaa…cccc')
    expect(organizationOperationDetail(operation)).toContain('rev-earl…0009')
    expect(organizationOperationDetail(operation)).toContain('rev-curr…0001')
  })

  it('names the copy a duplicate will create, including when it is an unsaved draft', () => {
    const titled: OrganizationOperation = {
      kind: 'duplicate_document',
      document_id: 'doc-aaaa-bbbb-cccc',
      expected_revision_id: 'rev-current-0001',
      title: 'Copy of notes',
      destination_path: 'notes/copy.md',
    }
    const draft: OrganizationOperation = { ...titled, title: null, destination_path: null }
    expect(organizationOperationDetail(titled)).toContain('notes/copy.md')
    expect(organizationOperationDetail(titled)).toContain('Copy of notes')
    expect(organizationOperationDetail(draft)).toContain('unsaved draft')
  })
})

describe('project change review', () => {
  it('parses each change the server can request and rejects anything else', () => {
    expect(parseProjectChange({ change: { kind: 'create_project', name: 'Atlas' } })).toMatchObject({
      kind: 'create_project',
      name: 'Atlas',
    })
    expect(
      parseProjectChange({ change: { kind: 'remove_document', project_id: 'p1', document_id: 'd1' } }),
    ).toMatchObject({ kind: 'remove_document' })
    expect(parseProjectChange({ change: { kind: 'delete_project', project_id: 'p1' } })).toBeNull()
    expect(parseProjectChange({})).toBeNull()
  })

  it('describes the exact change the reviewer approves', () => {
    const add = parseProjectChange({
      change: {
        kind: 'add_document',
        project_id: 'project-aaaa-bbbb',
        document_id: 'doc-aaaa-bbbb-cccc',
        role: 'draft',
        pinned_page: 4,
        notes: 'Start here',
      },
    })
    if (!add) throw new Error('add_document should parse')
    expect(projectChangeTitle(add)).toBe('Add document doc-aaaa…cccc to project project-…bbbb')
    expect(projectChangeDetail(add)).toBe('Role draft · pinned to page 4 · note: Start here')

    const create = parseProjectChange({
      change: { kind: 'create_project', name: 'Atlas', description: 'Q4 review', create_brief: false },
    })
    if (!create) throw new Error('create_project should parse')
    expect(projectChangeTitle(create)).toBe('Create project "Atlas"')
    expect(projectChangeDetail(create)).toBe('Q4 review · without a purpose brief')
  })
})

describe('plan operation copy for tags', () => {
  it('names the tag and its color, and says nothing is applied yet', () => {
    const operation: OrganizationOperation = { kind: 'create_tag', name: 'Legal', color: '#527ea3' }
    expect(organizationOperationTitle(operation)).toBe('Create tag "Legal"')
    expect(organizationOperationDetail(operation)).toBe('Color #527ea3 · not applied to anything yet')
  })
})

function effectWith(capabilityId: ChatEffect['capability_id'], preview: ChatEffect['preview']): ChatEffect {
  return {
    effect_id: 'eff_1',
    thread_id: 'thread_1',
    requested_by: 'human:jay',
    capability_id: capabilityId,
    capability_version: 1,
    argument_digest: 'a'.repeat(64),
    preview,
    effect_class: 'write',
    risk: 'workspace',
    status: 'pending_approval',
    expires_at: '2099-01-01T00:00:00Z',
    resource_type: null,
    resource_id: null,
    result: null,
    failure: null,
    created_at: '2026-01-01T00:00:00Z',
    decided_at: null,
    completed_at: null,
  }
}

describe('effect review copy', () => {
  it('describes every project change the server can request', () => {
    const cases: Array<[ChatEffect['preview'], string, string]> = [
      [
        {
          change: {
            kind: 'update_details',
            project_id: 'project-aaaa-bbbb',
            name: 'After',
            description: 'Why',
          },
        },
        'Update project project-…bbbb',
        'Name "After" · purpose "Why"',
      ],
      [
        {
          change: {
            kind: 'update_member',
            project_id: 'project-aaaa-bbbb',
            document_id: 'doc-aaaa-bbbb-cccc',
            role: 'draft',
            pinned_page: 2,
          },
        },
        'Change document doc-aaaa…cccc in project project-…bbbb',
        'Role draft · pinned to page 2',
      ],
      [
        { change: { kind: 'add_thread', project_id: 'project-aaaa-bbbb', thread_id: 'thread-aaaa-bbbb' } },
        'Attach conversation thread-a…bbbb to project project-…bbbb',
        'The conversation appears in the project; it is not changed',
      ],
      [
        {
          change: {
            kind: 'remove_annotation',
            project_id: 'project-aaaa-bbbb',
            annotation_id: 'annot-aaaa-bbbb',
          },
        },
        'Detach annotation annot-aa…bbbb from project project-…bbbb',
        'Membership only; the annotation itself is not changed',
      ],
    ]
    for (const [preview, title, detail] of cases) {
      const review = describeEffectReview(effectWith('update_project', preview))
      expect(review).toMatchObject({ title, detail, approveLabel: 'Approve project change' })
    }
  })

  it('describes publication changes with the version the reviewer is approving', () => {
    const withdraw = describeEffectReview(
      effectWith('update_publication', {
        change: { kind: 'unpublish', publication_id: 'pub-aaaa-bbbb-cccc', expected_version: 3 },
      }),
    )
    const change = describeEffectReview(
      effectWith('update_publication', {
        change: {
          kind: 'update',
          publication_id: 'pub-aaaa-bbbb-cccc',
          expected_version: 3,
          slug: 'new-slug',
          access_policy: 'private',
        },
      }),
    )
    expect(withdraw).toMatchObject({
      title: 'Withdraw publication pub-aaaa…cccc',
      detail: 'Readers lose access at once · publication version 3',
      approveLabel: 'Approve withdrawal',
    })
    expect(change).toMatchObject({
      title: 'Change publication pub-aaaa…cccc',
      detail: 'Slug new-slug · access private · publication version 3',
      approveLabel: 'Approve publication change',
    })
  })

  it('describes PDF annotation changes, truncating a long note', () => {
    const note = 'x'.repeat(300)
    const add = describeEffectReview(
      effectWith('annotate_pdf', {
        change: {
          kind: 'create',
          document_id: 'doc-aaaa-bbbb-cccc',
          page_number: 4,
          annotation_type: 'page_note',
          note,
        },
      }),
    )
    expect(add?.title).toBe('Add a page note to page 4 of document doc-aaaa…cccc')
    expect(add?.detail).toBe(`${'x'.repeat(160)}…`)
    const remove = describeEffectReview(
      effectWith('annotate_pdf', {
        change: { kind: 'delete', annotation_id: 'annot-aaaa-bbbb', expected_version: 2 },
      }),
    )
    expect(remove).toMatchObject({
      title: 'Delete annotation annot-aa…bbbb',
      detail: 'annotation version 2',
      approveLabel: 'Approve annotation change',
    })
  })

  it('has nothing to say about an effect it does not own, or a malformed preview', () => {
    expect(describeEffectReview(effectWith('create_document', {}))).toBeNull()
    expect(describeEffectReview(effectWith('update_project', { change: { kind: 'nope' } }))).toBeNull()
  })
})
