import { getResourceTimeBucket } from '@renderer/utils/chat/resourceListBase'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useDayBoundaryNow } from '../useDayBoundaryNow'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

describe('useDayBoundaryNow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 10, 10, 0, 0))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps date grouping aligned with the real day after the app stays open across midnight', () => {
    const { result } = renderHook(() => useDayBoundaryNow())
    const nowAtMount = result.current

    act(() => {
      vi.advanceTimersByTime(2 * DAY_MS)
    })
    const createdToday = new Date()

    // A `now` frozen at mount time buckets today's item as "earlier" — the bug this hook fixes.
    expect(getResourceTimeBucket(createdToday, nowAtMount)).toBe('earlier')
    expect(getResourceTimeBucket(createdToday, result.current)).toBe('today')
    expect(getResourceTimeBucket(new Date(2026, 0, 11, 10, 0, 0), result.current)).toBe('yesterday')
  })

  it('keeps the same reference while the local day does not change', () => {
    const { result } = renderHook(() => useDayBoundaryNow())
    const nowAtMount = result.current

    act(() => {
      vi.advanceTimersByTime(13 * HOUR_MS)
    })

    expect(result.current).toBe(nowAtMount)
  })

  it('catches up on the current day when the window becomes visible again after sleeping', () => {
    const { result } = renderHook(() => useDayBoundaryNow())
    const nowAtMount = result.current

    // Sleep/wake moves the wall clock without firing the pending midnight timer.
    vi.setSystemTime(new Date(2026, 0, 12, 9, 0, 0))
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(result.current).not.toBe(nowAtMount)
    expect(getResourceTimeBucket(new Date(), result.current)).toBe('today')
  })

  it('stops scheduling day rollovers once unmounted', () => {
    const timersBeforeMount = vi.getTimerCount()
    const { unmount } = renderHook(() => useDayBoundaryNow())
    expect(vi.getTimerCount()).toBe(timersBeforeMount + 1)

    unmount()

    expect(vi.getTimerCount()).toBe(timersBeforeMount)
  })
})
