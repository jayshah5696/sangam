import { describe, expect, it } from 'vitest'
import type { OrganizationOperation } from './api'
import {
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
