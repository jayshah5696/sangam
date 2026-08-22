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

  it('shows the exact effect and waits for approval', () => {
    const onApprove = vi.fn()
    const onCancel = vi.fn()
    render(
      <ChatCreateConfirmation
        request={{ title: 'Research note', content: '# Evidence', contentType: 'text/markdown' }}
        pending={false}
        error={false}
        onApprove={onApprove}
        onCancel={onCancel}
      />,
    )

    expect(screen.getByRole('alertdialog').textContent).toContain('No document is created until you approve')
    expect(screen.getByLabelText('Document content to create').textContent).toBe('# Evidence')
    fireEvent.click(screen.getByRole('button', { name: 'Approve document creation' }))
    expect(onApprove).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
  })
})
