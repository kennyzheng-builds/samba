import { useCallback, useEffect, useState } from 'react'

const DAY_ROLLOVER_BUFFER_MS = 1_000

const startOfLocalDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

/**
 * Returns a `now` reference for date grouping that follows the local calendar day.
 *
 * The reference only changes identity when the local day actually changes, so `useMemo` blocks keyed on it
 * survive re-renders. It is refreshed at the next local midnight and re-checked when the window regains focus
 * or becomes visible again, which covers sleep/wake and manual system clock changes.
 */
export const useDayBoundaryNow = (): Date => {
  const [now, setNow] = useState(() => new Date())

  const syncToCurrentDay = useCallback(() => {
    setNow((previous) => (startOfLocalDay(previous) === startOfLocalDay(new Date()) ? previous : new Date()))
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const scheduleNextDay = () => {
      clearTimeout(timer)
      const current = new Date()
      const nextDayStart = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1).getTime()
      timer = setTimeout(
        () => {
          syncToCurrentDay()
          scheduleNextDay()
        },
        Math.max(nextDayStart - current.getTime(), 0) + DAY_ROLLOVER_BUFFER_MS
      )
    }

    const resync = () => {
      syncToCurrentDay()
      scheduleNextDay()
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') resync()
    }

    scheduleNextDay()
    window.addEventListener('focus', resync)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', resync)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [syncToCurrentDay])

  return now
}
