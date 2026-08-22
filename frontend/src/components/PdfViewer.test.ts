import { describe, expect, it } from 'vitest'
import { normalizePdfRect } from '../pdfGeometry'

describe('normalizePdfRect', () => {
  it('rounds highlight height to a physical CSS pixel before normalizing it', () => {
    const host = { left: 10, top: 20, width: 200, height: 400 }
    const rect = { left: 30, top: 60, width: 80, height: 13.6 }

    expect(normalizePdfRect(rect, host)).toEqual({
      x: 0.1,
      y: 0.1,
      width: 0.4,
      height: 0.035,
    })
  })
})
