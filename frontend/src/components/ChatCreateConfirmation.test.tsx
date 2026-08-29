// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatCreateConfirmation, parseCreateConfirmation } from './ChatCreateConfirmation'

afterEach(cleanup)

describe('ChatCreateConfirmation', () => {
  it('rejects malformed client-tool arguments', () => {
    expect(parseCreateConfirmation({ title: '', content: 'draft' })).toBeNull()
    expect(parseCreateConfirmation({ title: 'Draft', content: 42 })).toBeNull()
  })

  it('parses Markdown content type', () => {
    const result = parseCreateConfirmation({ title: 'Note', content: '# Hi', content_type: 'text/markdown' })
    expect(result).toEqual({ title: 'Note', content: '# Hi', contentType: 'text/markdown', path: null })
  })

  it('parses HTML content type', () => {
    const result = parseCreateConfirmation({
      title: 'Page',
      content: '<h1>Hi</h1>',
      content_type: 'text/html',
    })
    expect(result).toEqual({ title: 'Page', content: '<h1>Hi</h1>', contentType: 'text/html', path: null })
  })

  it('falls back to Markdown when content_type is absent (v1 compat)', () => {
    const result = parseCreateConfirmation({ title: 'Legacy', content: '# Old' })
    expect(result).toEqual({ title: 'Legacy', content: '# Old', contentType: 'text/markdown', path: null })
  })

  it('rejects unsupported content types', () => {
    expect(parseCreateConfirmation({ title: 'Bad', content: 'x', content_type: 'text/plain' })).toBeNull()
    expect(
      parseCreateConfirmation({ title: 'Bad', content: 'x', content_type: 'application/pdf' }),
    ).toBeNull()
  })

  it('shows Markdown confirmation and waits for approval', () => {
    const onApprove = vi.fn()
    const onCancel = vi.fn()
    render(
      <ChatCreateConfirmation
        request={{ title: 'Research note', content: '# Evidence', contentType: 'text/markdown', path: null }}
        pending={false}
        error={false}
        onApprove={onApprove}
        onCancel={onCancel}
      />,
    )

    expect(screen.getByRole('alertdialog').textContent).toContain('No document is created until you approve')
    expect(screen.getByRole('alertdialog').textContent).toContain('Markdown document')
    expect(screen.getByLabelText('Document content to create').textContent).toBe('# Evidence')
    fireEvent.click(screen.getByRole('button', { name: 'Approve Markdown document creation' }))
    expect(onApprove).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('shows HTML confirmation with format-specific copy', () => {
    const onApprove = vi.fn()
    render(
      <ChatCreateConfirmation
        request={{
          title: 'Landing page',
          content: '<h1>Hello</h1>',
          contentType: 'text/html',
          path: 'sites/landing.html',
        }}
        pending={false}
        error={false}
        onApprove={onApprove}
        onCancel={() => {}}
      />,
    )

    expect(screen.getByRole('alertdialog').textContent).toContain('HTML document')
    expect(screen.getByRole('alertdialog').textContent).toContain('Create HTML document "Landing page"')
    expect(screen.getByRole('alertdialog').textContent).toContain('sites/landing.html')
    fireEvent.click(screen.getByRole('button', { name: 'Approve HTML document creation' }))
    expect(onApprove).toHaveBeenCalledOnce()
  })
})
