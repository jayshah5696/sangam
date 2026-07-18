// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { HtmlPreview } from './HtmlPreview'

afterEach(cleanup)

describe('HtmlPreview', () => {
  it('sanitizes active content and uses a script-disabled opaque sandbox', () => {
    const { container } = render(
      <HtmlPreview
        content={'<h1>Safe HTML</h1><script>window.bad = true</script><img src=x onerror="bad()">'}
      />,
    )
    const frame = container.querySelector('iframe')
    expect(frame?.getAttribute('sandbox')).toBe('')
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer')
    const source = frame?.getAttribute('srcdoc') ?? ''
    expect(source).toContain('Safe HTML')
    expect(source).toContain("script-src 'none'")
    expect(source).not.toContain('window.bad')
    expect(source).not.toContain('onerror')
  })
})
