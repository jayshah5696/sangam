// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownPreview } from './MarkdownPreview'

afterEach(cleanup)

describe('MarkdownPreview', () => {
  it('renders tables and stable document links while keeping raw scripts inert', () => {
    const { container } = render(
      <MarkdownPreview
        content={`# Safe preview

| Feature | State |
| --- | --- |
| Sanitizing | Ready |

[Linked note](sangam://document/123e4567-e89b-12d3-a456-426614174000)

<script>window.__unsafe = true</script>`}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Safe preview' })).toBeTruthy()
    expect(container.querySelector('table')).toBeTruthy()
    expect(container.querySelector('script')).toBeNull()
    expect((window as Window & { __unsafe?: boolean }).__unsafe).toBeUndefined()
    expect(screen.getByRole('link', { name: 'Linked note' }).getAttribute('href'))
      .toBe('/documents/123e4567-e89b-12d3-a456-426614174000')
  })

  it('hardens external links', () => {
    render(<MarkdownPreview content="[Reference](https://example.com)" />)
    const link = screen.getByRole('link', { name: 'Reference' })
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })
})
