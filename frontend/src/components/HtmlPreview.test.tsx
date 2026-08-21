// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { HtmlPreview } from './HtmlPreview'

afterEach(cleanup)

describe('HtmlPreview', () => {
  it('renders raw HTML content directly with scripts and styles preserved', () => {
    const { container } = render(
      <HtmlPreview
        content={
          '<style>h1 { color: green; }</style><h1>Interactive HTML</h1>' +
          '<script>window.active = true</script><img src="x" onerror="run()">'
        }
      />,
    )
    const frame = container.querySelector('iframe')
    expect(frame?.getAttribute('sandbox')).toContain('allow-scripts')
    expect(frame?.getAttribute('sandbox')).toContain('allow-same-origin')
    const source = frame?.getAttribute('srcdoc') ?? ''
    expect(source).toContain('Interactive HTML')
    expect(source).toContain('<style>h1 { color: green; }</style>')
    expect(source).toContain('<script>window.active = true</script>')
    expect(source).toContain('onerror="run()"')
  })
})
