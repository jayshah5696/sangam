// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { HtmlPreview } from './HtmlPreview'

afterEach(cleanup)

describe('HtmlPreview', () => {
  it('sanitizes scripts and event handlers in an opaque, script-disabled frame', () => {
    const { container } = render(
      <HtmlPreview
        content={
          '<style>h1 { color: green; }</style><h1>Static HTML</h1>' +
          '<script>window.active = true</script><img src="x" onerror="run()">'
        }
      />,
    )
    const frame = container.querySelector('iframe')
    expect(frame?.getAttribute('title')).toBe('Safe HTML preview')
    expect(frame?.getAttribute('sandbox')).toBe('')
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer')
    const source = frame?.getAttribute('srcdoc') ?? ''
    expect(source).toContain('Static HTML')
    expect(source).toContain('<style>h1 { color: green; }</style>')
    expect(source).toContain("script-src 'none'")
    expect(source).not.toContain('<script>')
    expect(source).not.toContain('onerror')
  })
})
