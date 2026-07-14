import type { PointerEvent as ReactPointerEvent } from 'react'

type ResizeHandleProps = {
  side: 'left' | 'right'
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}

export function ResizeHandle({ side, value, min, max, onChange }: ResizeHandleProps) {
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startValue = value
    const move = (pointerEvent: PointerEvent) => {
      const delta = pointerEvent.clientX - startX
      const next = side === 'left' ? startValue + delta : startValue - delta
      onChange(Math.max(min, Math.min(max, next)))
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
  }

  return (
    <div
      className="resize-handle"
      role="separator"
      aria-label={`Resize ${side} sidebar`}
      aria-orientation="vertical"
      onPointerDown={beginResize}
    />
  )
}
