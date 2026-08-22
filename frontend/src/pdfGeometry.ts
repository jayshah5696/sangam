import type { PdfRect } from './api'

type RectBounds = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>

export function normalizePdfRect(rect: RectBounds, host: RectBounds): PdfRect {
  const height = Math.max(1, Math.round(rect.height))
  return {
    x: Math.max(0, (rect.left - host.left) / host.width),
    y: Math.max(0, (rect.top - host.top) / host.height),
    width: Math.min(1, rect.width / host.width),
    height: Math.min(1, height / host.height),
  }
}
