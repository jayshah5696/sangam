import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'

type ResizeHandleProps = {
  side: 'left' | 'right'
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}

export function ResizeHandle({ side, value, min, max, onChange }: ResizeHandleProps) {
  const clamp = (next: number) => Math.max(min, Math.min(max, next))
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startValue = value
    const move = (pointerEvent: PointerEvent) => {
      const delta = pointerEvent.clientX - startX
      const next = side === 'left' ? startValue + delta : startValue - delta
      onChange(clamp(next))
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
  }

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const direction = side === 'left' ? 1 : -1
    const step = event.shiftKey ? 40 : 10
    let next: number | undefined
    if (event.key === 'ArrowLeft') next = value - step * direction
    if (event.key === 'ArrowRight') next = value + step * direction
    if (event.key === 'Home') next = min
    if (event.key === 'End') next = max
    if (next === undefined) return
    event.preventDefault()
    onChange(clamp(next))
  }

  return (
    <div
      className="resize-handle"
      role="separator"
      tabIndex={0}
      aria-label={`Resize ${side} sidebar`}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      onPointerDown={beginResize}
      onKeyDown={resizeWithKeyboard}
    />
  )
}
