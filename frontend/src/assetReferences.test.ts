import { describe, expect, it } from 'vitest'
import { isWorkspaceAssetReference } from './assetReferences'

describe('isWorkspaceAssetReference', () => {
  it('resolves shared attachments and document-relative images', () => {
    expect(isWorkspaceAssetReference('/attachments/chart-0123456789abcdef.png')).toBe(true)
    expect(isWorkspaceAssetReference('diagram.png')).toBe(true)
  })

  it('leaves URLs, other root paths, data, and fragments alone', () => {
    for (const reference of [
      'https://example.com/a.png',
      '/assets/index.js',
      'data:image/png;base64,x',
      '#top',
      '',
    ])
      expect(isWorkspaceAssetReference(reference)).toBe(false)
  })
})
