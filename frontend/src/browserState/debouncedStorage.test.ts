// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DebouncedStorageWriter } from './debouncedStorage'

afterEach(() => vi.useRealTimers())

describe('DebouncedStorageWriter', () => {
  it('coalesces rapid layout updates and flushes the latest state', async () => {
    vi.useFakeTimers()
    const storage = { setItem: vi.fn() } as unknown as Storage
    const writer = new DebouncedStorageWriter(storage, 'layout', 100)

    writer.schedule({ ratio: 40 })
    writer.schedule({ ratio: 45 })
    writer.schedule({ ratio: 50 })
    await vi.advanceTimersByTimeAsync(99)
    expect(storage.setItem).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(storage.setItem).toHaveBeenCalledOnce()
    expect(storage.setItem).toHaveBeenCalledWith('layout', JSON.stringify({ ratio: 50 }))
  })

  it('flushes a pending update synchronously when disposed', () => {
    vi.useFakeTimers()
    const storage = { setItem: vi.fn() } as unknown as Storage
    const writer = new DebouncedStorageWriter(storage, 'layout')
    writer.schedule({ activeGroupId: 'group-2' })
    writer.dispose()
    expect(storage.setItem).toHaveBeenCalledOnce()
  })
})
