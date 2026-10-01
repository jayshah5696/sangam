// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownEditor } from './MarkdownEditor'

afterEach(cleanup)

describe('MarkdownEditor', () => {
  it('renders markdown editor without error', () => {
    const onChange = vi.fn()
    const { container } = render(
      <MarkdownEditor
        value="# Test"
        onChange={onChange}
        availableDocuments={[
          {
            document_id: 'doc-1',
            title: 'First Document',
            content_type: 'text/markdown',
            path: 'notes/first.md',
            current_revision_id: 'rev-1',
            content_hash: 'h1',
            size_bytes: 10,
            materialization_state: 'clean',
            file_hash: null,
            deleted: false,
            created_by: 'u1',
            created_at: '2026-09-30T00:00:00Z',
            updated_at: '2026-09-30T00:00:00Z',
            updated_by: 'u1',
            updated_by_name: 'User 1',
            revision_summary: null,
            category: null,
            metadata_version: 1,
            trust_level: 'untrusted',
            trust_version: 1,
            tags: [],
            search_snippet: null,
            pdf_page_count: null,
            pdf_extraction_status: null,
            pdf_extraction_error: null,
            supersedes_document_id: null,
          },
        ]}
      />,
    )

    expect(container.querySelector('.cm-editor')).not.toBeNull()
  })
})
